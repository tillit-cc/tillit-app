import { splitTextWithLinks, extractFirstLink, hasLink } from './links';

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' },
}));

describe('splitTextWithLinks', () => {
  it('returns single text segment when there are no links', () => {
    expect(splitTextWithLinks('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(splitTextWithLinks('')).toEqual([]);
  });

  it('extracts a single https link in the middle of text', () => {
    const result = splitTextWithLinks('Visit https://example.com for info');
    expect(result).toEqual([
      { type: 'text', value: 'Visit ' },
      { type: 'link', url: 'https://example.com', raw: 'https://example.com' },
      { type: 'text', value: ' for info' },
    ]);
  });

  it('extracts a www link without scheme (fuzzy)', () => {
    const result = splitTextWithLinks('Sito www.tillit.cc oggi');
    expect(result[0]).toEqual({ type: 'text', value: 'Sito ' });
    expect(result[1].type).toBe('link');
    expect((result[1] as any).raw).toBe('www.tillit.cc');
    expect((result[1] as any).url).toBe('http://www.tillit.cc');
    expect(result[2]).toEqual({ type: 'text', value: ' oggi' });
  });

  it('does not include trailing punctuation in the link', () => {
    const result = splitTextWithLinks('Vai a https://example.com.');
    const link = result.find((s) => s.type === 'link') as any;
    expect(link.raw).toBe('https://example.com');
    const last = result[result.length - 1] as any;
    expect(last.type).toBe('text');
    expect(last.value).toBe('.');
  });

  it('handles multiple links', () => {
    const result = splitTextWithLinks('Due link: https://a.io e https://b.io fine');
    const links = result.filter((s) => s.type === 'link') as any[];
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://a.io');
    expect(links[1].url).toBe('https://b.io');
  });

  it('treats a link at the start without a preceding text segment', () => {
    const result = splitTextWithLinks('https://example.com is great');
    expect(result[0]).toEqual({
      type: 'link',
      url: 'https://example.com',
      raw: 'https://example.com',
    });
    expect(result[1]).toEqual({ type: 'text', value: ' is great' });
  });

  it('treats a link at the end without a trailing text segment', () => {
    const result = splitTextWithLinks('go to https://example.com');
    const last = result[result.length - 1] as any;
    expect(last.type).toBe('link');
    expect(last.url).toBe('https://example.com');
  });

  it('detects fuzzy email and prefixes with mailto:', () => {
    const result = splitTextWithLinks('write to mail@example.com please');
    const link = result.find((s) => s.type === 'link') as any;
    expect(link).toBeDefined();
    expect(link.url).toBe('mailto:mail@example.com');
    expect(link.raw).toBe('mail@example.com');
  });
});

describe('extractFirstLink', () => {
  it('returns null when there is no link', () => {
    expect(extractFirstLink('just some text')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractFirstLink('')).toBeNull();
  });

  it('returns the first link when multiple are present', () => {
    expect(extractFirstLink('see https://a.io and https://b.io')).toBe('https://a.io');
  });

  it('returns the normalized url for a www-only link', () => {
    expect(extractFirstLink('go to www.tillit.cc')).toBe('http://www.tillit.cc');
  });
});

describe('hasLink', () => {
  it('returns false for plain text', () => {
    expect(hasLink('hello there')).toBe(false);
  });

  it('returns true when an https link is present', () => {
    expect(hasLink('check https://example.com out')).toBe(true);
  });

  it('returns true for www-style links', () => {
    expect(hasLink('see www.tillit.cc')).toBe(true);
  });
});
