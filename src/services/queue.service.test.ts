import { MessageEnvelope } from '@/types/message';

// Mock logger to avoid Zustand store dependency.
// Use the resolved path that matches the specific moduleNameMapper entry.
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Import the singleton — we reset its state in beforeEach
import { queueService } from './queue.service';

function makeEnvelope(id = 'msg-1'): MessageEnvelope {
  return {
    id,
    timestamp: Date.now(),
    category: 'user',
    type: 'text',
    payload: { text: 'hello' },
    id_room: 1,
    id_user_from: 42,
  };
}

describe('QueueService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    queueService.stopProcessor();
    queueService.clearQueue();
    // Reset send function by setting a null-ish value;
    // setSendFunction accepts a function, so we cast to reset
    queueService.setSendFunction(null as any);
  });

  afterEach(() => {
    queueService.stopProcessor();
    queueService.clearQueue();
    jest.useRealTimers();
  });

  describe('addMessage', () => {
    it('adds a message to the queue and getQueueSize returns 1', () => {
      const envelope = makeEnvelope('msg-1');
      queueService.addMessage(envelope);
      expect(queueService.getQueueSize()).toBe(1);
    });

    it('deduplicates messages with the same id', () => {
      const envelope = makeEnvelope('msg-dup');
      queueService.addMessage(envelope);
      queueService.addMessage(envelope);
      expect(queueService.getQueueSize()).toBe(1);
    });
  });

  describe('removeMessage', () => {
    it('removes an existing message and returns true', () => {
      const envelope = makeEnvelope('msg-rm');
      queueService.addMessage(envelope);
      expect(queueService.removeMessage('msg-rm')).toBe(true);
      expect(queueService.getQueueSize()).toBe(0);
    });

    it('returns false when removing a non-existing message', () => {
      expect(queueService.removeMessage('non-existing')).toBe(false);
    });
  });

  describe('getQueuedMessages', () => {
    it('returns the envelope data for all queued messages', () => {
      const e1 = makeEnvelope('msg-a');
      const e2 = makeEnvelope('msg-b');
      queueService.addMessage(e1);
      queueService.addMessage(e2);

      const messages = queueService.getQueuedMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe('msg-a');
      expect(messages[1].id).toBe('msg-b');
    });
  });

  describe('clearQueue', () => {
    it('empties the queue', () => {
      queueService.addMessage(makeEnvelope('msg-c1'));
      queueService.addMessage(makeEnvelope('msg-c2'));
      expect(queueService.getQueueSize()).toBe(2);

      queueService.clearQueue();
      expect(queueService.getQueueSize()).toBe(0);
    });
  });

  describe('processQueue (via forceProcess)', () => {
    it('removes a message and calls onSuccess when send succeeds', async () => {
      const onSuccess = jest.fn();
      const envelope = makeEnvelope('msg-ok');
      const sendFn = jest.fn().mockResolvedValue({ success: true });

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope, { onSuccess });

      // Advance time past the initial backoff (1000ms for retry 0)
      jest.advanceTimersByTime(1500);

      await queueService.forceProcess();

      expect(sendFn).toHaveBeenCalledWith(envelope);
      expect(onSuccess).toHaveBeenCalledWith({ success: true });
      expect(queueService.getQueueSize()).toBe(0);
    });

    it('schedules retry and increments retryCount when send returns non-success', async () => {
      const envelope = makeEnvelope('msg-fail');
      const sendFn = jest.fn().mockResolvedValue({ success: false });

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope);

      // Advance past initial backoff
      jest.advanceTimersByTime(1500);
      await queueService.forceProcess();

      // Message should still be in queue
      expect(queueService.getQueueSize()).toBe(1);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('schedules retry when send throws an error', async () => {
      const envelope = makeEnvelope('msg-throw');
      const sendFn = jest.fn().mockRejectedValue(new Error('network error'));

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope);

      jest.advanceTimersByTime(1500);
      await queueService.forceProcess();

      // Message should still be in queue after error
      expect(queueService.getQueueSize()).toBe(1);
    });

    it('calls onError and removes message when max retries exceeded', async () => {
      const onError = jest.fn();
      const envelope = makeEnvelope('msg-maxretry');
      const sendFn = jest.fn().mockResolvedValue({ success: false });

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope, { maxRetries: 2, onError });

      // Retry 0: advance past initial backoff (1000ms), process
      jest.advanceTimersByTime(1500);
      await queueService.forceProcess();
      expect(queueService.getQueueSize()).toBe(1); // retryCount now 1

      // Retry 1: advance past 2^1 * 1000 = 2000ms backoff
      jest.advanceTimersByTime(2500);
      await queueService.forceProcess();
      expect(queueService.getQueueSize()).toBe(1); // retryCount now 2

      // retryCount (2) >= maxRetries (2) => removed on next process
      jest.advanceTimersByTime(5000);
      await queueService.forceProcess();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toBe('Max retries exceeded');
      expect(queueService.getQueueSize()).toBe(0);
    });

    it('skips messages whose nextRetryAt is in the future', async () => {
      const envelope = makeEnvelope('msg-notready');
      const sendFn = jest.fn().mockResolvedValue({ success: true });

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope);

      // Do NOT advance time — nextRetryAt is Date.now() + 1000
      await queueService.forceProcess();

      expect(sendFn).not.toHaveBeenCalled();
      expect(queueService.getQueueSize()).toBe(1);
    });

    it('does nothing when no send function is configured', async () => {
      queueService.addMessage(makeEnvelope('msg-nosend'));

      jest.advanceTimersByTime(1500);
      await queueService.forceProcess();

      // Message stays in queue, no crash
      expect(queueService.getQueueSize()).toBe(1);
    });
  });

  describe('calculateBackoff', () => {
    it('uses exponential backoff capped at 60000ms', async () => {
      // We test backoff indirectly through retry scheduling.
      // After each failed send, nextRetryAt should increase exponentially.
      const envelope = makeEnvelope('msg-backoff');
      const sendFn = jest.fn().mockResolvedValue({ success: false });

      queueService.setSendFunction(sendFn);
      queueService.addMessage(envelope, { maxRetries: 20 });

      // Initial backoff: 2^0 * 1000 = 1000ms
      jest.advanceTimersByTime(1001);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(1);

      // After retry 0 fails, retryCount=1, next backoff: 2^1 * 1000 = 2000ms
      // Advance only 1500ms — should NOT be enough
      jest.advanceTimersByTime(1500);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(1); // not called again

      // Advance remaining 600ms to reach 2000ms total since last retry
      jest.advanceTimersByTime(600);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(2);

      // retryCount=2, backoff: 2^2 * 1000 = 4000ms
      jest.advanceTimersByTime(4100);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(3);

      // Now exhaust through retries to get retryCount to 6
      // retryCount=3, backoff: 2^3 * 1000 = 8000ms
      jest.advanceTimersByTime(8100);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(4);

      // retryCount=4, backoff: 2^4 * 1000 = 16000ms
      jest.advanceTimersByTime(16100);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(5);

      // retryCount=5, backoff: 2^5 * 1000 = 32000ms
      jest.advanceTimersByTime(32100);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(6);

      // retryCount=6, backoff should be capped: min(2^6*1000, 60000) = 60000
      // Advance 59999ms — should NOT trigger
      jest.advanceTimersByTime(59999);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(6);

      // Advance remaining 2ms — now should trigger
      jest.advanceTimersByTime(2);
      await queueService.forceProcess();
      expect(sendFn).toHaveBeenCalledTimes(7);
    });
  });

  describe('startProcessor / stopProcessor', () => {
    it('starts the interval processor', () => {
      const sendFn = jest.fn().mockResolvedValue({ success: true });
      queueService.setSendFunction(sendFn);
      queueService.addMessage(makeEnvelope('msg-proc'));

      queueService.startProcessor();

      // Advance past initial backoff + processor interval (5000ms)
      jest.advanceTimersByTime(6000);

      // The processor should have called the send function
      // (processQueue is async but setInterval fires synchronously in fake timers)
      expect(sendFn).toHaveBeenCalled();
    });

    it('is idempotent — calling startProcessor twice does not create duplicate intervals', () => {
      const spy = jest.spyOn(global, 'setInterval');

      queueService.startProcessor();
      queueService.startProcessor();

      // setInterval should have been called only once by our service
      // (filter calls to only count our 5000ms interval)
      const relevantCalls = spy.mock.calls.filter(
        (call) => call[1] === 5000
      );
      expect(relevantCalls).toHaveLength(1);

      spy.mockRestore();
    });

    it('stops and clears the interval', () => {
      const spy = jest.spyOn(global, 'clearInterval');

      queueService.startProcessor();
      queueService.stopProcessor();

      expect(spy).toHaveBeenCalled();

      // Starting again after stop should work
      queueService.startProcessor();
      const sendFn = jest.fn().mockResolvedValue({ success: true });
      queueService.setSendFunction(sendFn);
      queueService.addMessage(makeEnvelope('msg-restart'));

      jest.advanceTimersByTime(6000);
      expect(sendFn).toHaveBeenCalled();

      spy.mockRestore();
    });
  });
});
