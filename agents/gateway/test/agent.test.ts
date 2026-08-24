/**
 * What the Gemma span extractor guarantees: hallucinated spans are discarded,
 * repeated values are all found, and a model failure degrades to no spans rather
 * than failing the request.
 */

import { describe, expect, it } from 'vitest';
import { extractUnstructured, parseSpans, spansToDetections } from '../src/agent.ts';

describe('parseSpans', () => {
  it('reads a well-formed response', () => {
    const spans = parseSpans('{"spans": [{"text": "Taro Yamada", "category": "PERSON"}]}');
    expect(spans).toEqual([{ text: 'Taro Yamada', category: 'PERSON' }]);
  });

  it('reads JSON wrapped in a code fence', () => {
    // Models asked for JSON still occasionally fence it.
    const raw = '```json\n{"spans": [{"text": "Acme", "category": "ORGANIZATION"}]}\n```';
    expect(parseSpans(raw)).toEqual([{ text: 'Acme', category: 'ORGANIZATION' }]);
  });

  it('returns nothing for an empty extraction', () => {
    expect(parseSpans('{"spans": []}')).toEqual([]);
  });

  it('returns nothing rather than throwing on malformed JSON', () => {
    expect(parseSpans('not json at all')).toEqual([]);
    expect(parseSpans('{"spans": [')).toEqual([]);
    expect(parseSpans('')).toEqual([]);
  });

  it('keeps the valid spans when one entry names an unknown category', () => {
    // Dropping the whole response over one bad entry would weaken masking for no gain.
    const raw =
      '{"spans": [{"text": "Taro", "category": "PERSON"}, {"text": "x", "category": "BANANA"}]}';
    expect(parseSpans(raw)).toEqual([{ text: 'Taro', category: 'PERSON' }]);
  });
});

describe('spansToDetections', () => {
  it('locates the span offsets in the source text', () => {
    const text = 'Contact Taro Yamada today';
    const detections = spansToDetections(text, [{ text: 'Taro Yamada', category: 'PERSON' }]);

    expect(detections).toHaveLength(1);
    expect(text.slice(detections[0]?.start, detections[0]?.end)).toBe('Taro Yamada');
    expect(detections[0]?.category).toBe('PERSON');
  });

  it('captures every occurrence of a repeated value', () => {
    const detections = spansToDetections('Taro met Taro', [{ text: 'Taro', category: 'PERSON' }]);
    expect(detections).toHaveLength(2);
    expect(detections[1]?.start).toBe(9);
  });

  it('discards a span the model invented', () => {
    // A value absent from the input cannot be masked, and trusting it would put a
    // bogus placeholder into the prompt.
    const detections = spansToDetections('nothing here', [
      { text: 'Ghost Person', category: 'PERSON' },
    ]);
    expect(detections).toEqual([]);
  });
});

describe('extractUnstructured', () => {
  it('returns the detections the model found', async () => {
    const detections = await extractUnstructured('Contact Taro Yamada', {
      runAgent: () => Promise.resolve('{"spans": [{"text": "Taro Yamada", "category": "PERSON"}]}'),
    });
    expect(detections).toHaveLength(1);
  });

  it('retries once on an unusable response', async () => {
    let attempts = 0;
    const detections = await extractUnstructured('Contact Taro Yamada', {
      runAgent: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? 'sorry, I cannot'
            : '{"spans": [{"text": "Taro Yamada", "category": "PERSON"}]}',
        );
      },
    });

    expect(attempts).toBe(2);
    expect(detections).toHaveLength(1);
  });

  it('degrades to no spans when Gemma is down', async () => {
    // The deterministic regex masking still holds, and the egress guard remains
    // the last line of defense, so failing the whole request would be worse.
    const detections = await extractUnstructured('Contact Taro Yamada', {
      runAgent: () => Promise.reject(new Error('connection refused')),
    });
    expect(detections).toEqual([]);
  });

  it('accepts an empty extraction without retrying', async () => {
    let attempts = 0;
    const detections = await extractUnstructured('nothing sensitive', {
      runAgent: () => {
        attempts += 1;
        return Promise.resolve('{"spans": []}');
      },
    });

    expect(attempts).toBe(1);
    expect(detections).toEqual([]);
  });
});
