import { describe, expect, test } from 'bun:test';
import { parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  test('parses a standard frontmatter + body', () => {
    const input = `---
name: systematic-debugging
description: Use when stuck
---
# Body
text`;
    const out = parseFrontmatter(input);
    expect(out.hasFrontmatter).toBe(true);
    expect(out.data).toEqual({
      name: 'systematic-debugging',
      description: 'Use when stuck',
    });
    expect(out.body).toBe('# Body\ntext');
  });

  test('returns empty data + full content when there is no frontmatter', () => {
    const input = '# Just a markdown file\nno frontmatter here\n';
    const out = parseFrontmatter(input);
    expect(out.hasFrontmatter).toBe(false);
    expect(out.data).toEqual({});
    expect(out.body).toBe(input);
  });

  test('handles an empty frontmatter block', () => {
    const input = '---\n\n---\nbody';
    const out = parseFrontmatter(input);
    expect(out.hasFrontmatter).toBe(true);
    expect(out.data).toEqual({});
    expect(out.body).toBe('body');
  });

  test('handles CRLF line endings', () => {
    const input = '---\r\nname: x\r\ndescription: y\r\n---\r\nbody';
    const out = parseFrontmatter(input);
    expect(out.hasFrontmatter).toBe(true);
    expect(out.data).toEqual({ name: 'x', description: 'y' });
  });

  test('throws on scalar frontmatter (must be a mapping)', () => {
    const input = '---\njust a string\n---\nbody';
    expect(() => parseFrontmatter(input)).toThrow(/mapping/);
  });

  test('throws on array frontmatter', () => {
    const input = '---\n- one\n- two\n---\nbody';
    expect(() => parseFrontmatter(input)).toThrow(/mapping/);
  });
});
