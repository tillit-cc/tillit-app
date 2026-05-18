import { MessageEnvelope } from '@/types/message';
import { logger } from '@/utils/logger';

/**
 * Queue item with exponential backoff for offline retry
 */
export interface QueueItem<T = MessageEnvelope> {
  id: string;
  data: T;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: number;
  createdAt: number;
  onSuccess?: (result: any) => void;
  onError?: (error: Error) => void;
}

/**
 * Calculate next retry time with exponential backoff
 * Formula: 2^retryCount * 1000ms (max 60 seconds)
 */
function calculateBackoff(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * 1000, 60000);
}

/**
 * Offline queue service with exponential backoff retry
 */
class QueueService {
  private messageQueue: QueueItem<MessageEnvelope>[] = [];
  private processorInterval: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private sendFunction: ((envelope: MessageEnvelope) => Promise<any>) | null = null;

  /**
   * Set the send function to be called for each queued message
   */
  setSendFunction(fn: (envelope: MessageEnvelope) => Promise<any>): void {
    this.sendFunction = fn;
  }

  /**
   * Add a message to the retry queue
   */
  addMessage(
    envelope: MessageEnvelope,
    options: {
      maxRetries?: number;
      onSuccess?: (result: any) => void;
      onError?: (error: Error) => void;
    } = {}
  ): void {
    const { maxRetries = 5, onSuccess, onError } = options;

    // Check if already in queue
    const existingIndex = this.messageQueue.findIndex((item) => item.id === envelope.id);
    if (existingIndex !== -1) {
      logger.info('[Queue] Message already in queue:', envelope.id);
      return;
    }

    const backoffMs = calculateBackoff(0);
    const item: QueueItem<MessageEnvelope> = {
      id: envelope.id,
      data: envelope,
      retryCount: 0,
      maxRetries,
      nextRetryAt: Date.now() + backoffMs,
      createdAt: Date.now(),
      onSuccess,
      onError,
    };

    this.messageQueue.push(item);
    logger.info(`[Queue] Message added, retry in ${backoffMs}ms, queue size:`, this.messageQueue.length);
  }

  /**
   * Remove a message from the queue
   */
  removeMessage(id: string): boolean {
    const index = this.messageQueue.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.messageQueue.splice(index, 1);
      logger.info('[Queue] Message removed:', id);
      return true;
    }
    return false;
  }

  /**
   * Remove all messages for a given room from the queue
   */
  removeMessagesByRoom(roomId: number): number {
    const before = this.messageQueue.length;
    this.messageQueue = this.messageQueue.filter((item) => item.data.id_room !== roomId);
    const removed = before - this.messageQueue.length;
    if (removed > 0) {
      logger.info('[Queue] Removed', removed, 'messages for room', roomId);
    }
    return removed;
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Get all queued messages
   */
  getQueuedMessages(): MessageEnvelope[] {
    return this.messageQueue.map((item) => item.data);
  }

  /**
   * Start the queue processor
   * Checks every 5 seconds for messages ready to retry
   */
  startProcessor(): void {
    if (this.processorInterval) {
      logger.info('[Queue] Processor already running');
      return;
    }

    logger.info('[Queue] Processor started');
    this.processorInterval = setInterval(() => {
      this.processQueue();
    }, 5000);
  }

  /**
   * Stop the queue processor
   */
  stopProcessor(): void {
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
      logger.info('[Queue] Processor stopped');
    }
  }

  /**
   * Process the queue, retrying messages that are ready
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) {
      return;
    }

    if (!this.sendFunction) {
      logger.warn('[Queue] No send function configured');
      return;
    }

    this.isProcessing = true;
    const now = Date.now();

    logger.info('[Queue] Processing, queue size:', this.messageQueue.length);

    // Process in reverse order to safely remove items
    for (let i = this.messageQueue.length - 1; i >= 0; i--) {
      const item = this.messageQueue[i];

      // Check if exceeded max retries
      if (item.retryCount >= item.maxRetries) {
        logger.error('[Queue] Max retries exceeded:', item.id);
        item.onError?.(new Error('Max retries exceeded'));
        this.messageQueue.splice(i, 1);
        continue;
      }

      // Check if ready for retry
      if (now < item.nextRetryAt) {
        continue;
      }

      logger.info(`[Queue] Retrying message ${item.id}, attempt ${item.retryCount + 1}/${item.maxRetries}`);

      try {
        const result = await this.sendFunction(item.data);

        if (result?.success) {
          logger.info('[Queue] Message sent successfully:', item.id);
          item.onSuccess?.(result);
          this.messageQueue.splice(i, 1);
        } else {
          // Invalid response, schedule retry
          this.scheduleRetry(item);
        }
      } catch (error) {
        logger.error('[Queue] Retry failed:', item.id, error);
        this.scheduleRetry(item);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Schedule next retry for an item
   */
  private scheduleRetry(item: QueueItem): void {
    item.retryCount++;
    const backoffMs = calculateBackoff(item.retryCount);
    item.nextRetryAt = Date.now() + backoffMs;
    logger.info(`[Queue] Retry ${item.retryCount}/${item.maxRetries} scheduled in ${backoffMs}ms for:`, item.id);
  }

  /**
   * Clear the entire queue
   */
  clearQueue(): void {
    const size = this.messageQueue.length;
    this.messageQueue = [];
    logger.info('[Queue] Cleared', size, 'items');
  }

  /**
   * Force process the queue immediately
   */
  async forceProcess(): Promise<void> {
    await this.processQueue();
  }
}

export const queueService = new QueueService();
export default queueService;
