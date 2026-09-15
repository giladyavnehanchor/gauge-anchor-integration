import { describe, expect, it } from 'vitest';
import { authCheck, gaugeFindArticle, gaugePublishArticle, searchConsoleRequestIndexing } from '../src/tasks.js';
import { testConfig } from './fakes.js';

const [gaugeTarget, searchConsoleTarget] = testConfig().targets;

describe('task definitions', () => {
  it('names the auth check per target and only adds Gauge markers for Gauge', () => {
    const gauge = authCheck(gaugeTarget!);
    const searchConsole = authCheck(searchConsoleTarget!);

    expect(gauge.name).toBe('anchor-identity-monitor-gauge-dom-check');
    expect(gauge.aiFallback).toBe(false);
    expect(gauge.prompt).toContain('Generate Now');
    expect(searchConsole.name).toBe('anchor-identity-monitor-search-console-dom-check');
    expect(searchConsole.prompt).not.toContain('Generate Now');
    expect(gauge.parse({ authenticated: 'false' })).toBe(false);
    expect(() => gauge.parse({})).toThrow('missing boolean authenticated');
  });

  it('parses a discovered article and returns null when nothing is open', () => {
    const output = {
      ticket_url: 'https://app.withgauge.com/tasks/ticket-1',
      article_title: 'A Gauge article',
      article_summary: 'Summary',
      research_completed: true,
      outline_completed: false,
      published: false,
      message: 'Outline pending',
    };

    expect(gaugeFindArticle.parse(output)).toEqual({
      ticketUrl: 'https://app.withgauge.com/tasks/ticket-1',
      title: 'A Gauge article',
      summary: 'Summary',
      researchCompleted: true,
      outlineCompleted: false,
      message: 'Outline pending',
    });
    expect(gaugeFindArticle.parse({ ...output, article_title: 'No article found' })).toBeNull();
  });

  it('refuses a discovery result that claims to have published', () => {
    expect(() => gaugeFindArticle.parse({ published: true, article_title: 'x' })).toThrow('unsafe published=true');
  });

  it('returns the article URL only when publishing completed', () => {
    expect(gaugePublishArticle.parse({ published: true, article_url: 'https://anchorbrowser.io/blog/a' })).toBe(
      'https://anchorbrowser.io/blog/a',
    );
    expect(() => gaugePublishArticle.parse({ published: false, message: 'Ticket not in Todo' })).toThrow(
      'did not publish: Ticket not in Todo',
    );
  });

  it('parses the indexing result', () => {
    expect(searchConsoleRequestIndexing.parse({ indexing_requested: true, message: 'Requested' })).toEqual({
      requested: true,
      message: 'Requested',
    });
  });
});
