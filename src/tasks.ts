import type { Article, TargetConfig, TaskDefinition } from './types.js';

export function str(output: Record<string, unknown>, key: string): string {
  const value = output[key];
  if (typeof value !== 'string' || !value) throw new Error(`Anchor task result is missing ${key}`);
  return value;
}

export function bool(output: Record<string, unknown>, key: string): boolean {
  const value = output[key];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`Anchor task result is missing boolean ${key}`);
}

export function authCheck(target: TargetConfig): TaskDefinition<boolean> {
  const gaugeMarkers = target.key === 'gauge'
    ? `
Gauge-specific authenticated markers:
- visible navigation or text for Triage
- visible navigation or text for Tasks
- a visible Generate Now control
- a visible Ask Gauge input
Use separate valid Playwright locators for these checks, such as getByText or
getByPlaceholder. Do not combine Playwright text= selectors with CSS selectors
in a comma-separated selector. Treat Gauge as authenticated when at least one
Gauge-specific marker is visible and no login state is visible.`
    : '';

  return {
    name: `anchor-identity-monitor-${target.key}-dom-check`,
    description: `Deterministic DOM authentication check for ${target.applicationUrl}`,
    aiFallback: false,
    inputSchema: [],
    outputSchema: [
      { name: 'authenticated', type: 'boolean', description: 'Whether the DOM shows an authenticated user session' },
    ],
    parse: (output) => bool(output, 'authenticated'),
    prompt: `Objective:
Check whether the current user is authenticated on ${target.applicationUrl}.

Start URL:
${target.applicationUrl}

Steps:
1. Wait for the page to finish loading.
2. Inspect the DOM only. Do not use an AI agent, click, submit, fill, or navigate.
3. Treat a visible app shell as authenticated. Check visible navigation/sidebar/workspace
   elements and visible text such as workspace, projects, dashboard, settings, account,
   sign out, or log out. Hidden text does not count.
${gaugeMarkers}
4. Return authenticated=false when visible sign-in/login controls, a password form,
   registration, password-reset, access-denied, or login-required state is present,
   or when the URL is a login route. Ignore incidental article or help text mentioning
   "log in" or "sign in".
5. Return an object with the exact boolean field authenticated.

Output:
- authenticated (boolean)`,
  };
}

export const gaugeFindArticle: TaskDefinition<Article | null> = {
  name: 'gauge-content-research-outline-draft',
  description: 'Research, outline, and draft an open Gauge write-content ticket without publishing.',
  aiFallback: true,
  longRunning: true,
  inputSchema: [],
  outputSchema: [
    { name: 'ticket_url', type: 'string', description: 'URL of the selected write-content ticket, or the current Gauge URL if none exists' },
    { name: 'article_title', type: 'string', description: 'Title of the article from the content ticket' },
    { name: 'article_summary', type: 'string', description: 'Concise summary of the article content' },
    { name: 'research_completed', type: 'boolean', description: 'Whether research is complete' },
    { name: 'outline_completed', type: 'boolean', description: 'Whether outline is complete' },
    { name: 'article_written', type: 'boolean', description: 'Whether the article draft is written' },
    { name: 'published', type: 'boolean', description: 'Must remain false because publishing is prohibited' },
    { name: 'message', type: 'string', description: 'Concise task result' },
  ],
  parse: (output) => {
    if (bool(output, 'published')) {
      throw new Error('Gauge content task reported an unsafe published=true result');
    }
    const title = str(output, 'article_title');
    if (title.trim().toLocaleLowerCase() === 'no article found') return null;
    return {
      ticketUrl: str(output, 'ticket_url'),
      title,
      summary: str(output, 'article_summary'),
      researchCompleted: bool(output, 'research_completed'),
      outlineCompleted: bool(output, 'outline_completed'),
      articleWritten: bool(output, 'article_written'),
      message: str(output, 'message'),
    };
  },
  prompt: `Objective:
Process one currently open Gauge "write content" ticket through research, outline, and
the written article draft, then stop before publishing. The task must be safe to rerun
when some stages are already complete.

Start URL:
https://app.withgauge.com

Steps:
1. Inspect the current Gauge workspace and navigate to Triage. If a Generate Now action
   is available and has not already been completed for the current triage item, click
   Generate Now once. If generation is already complete or in progress, do not click it again.
   If it got tasks pending, click accept on all of them until there are no more.
2. Wait generously for Gauge research to finish: allow up to 5 minutes, checking visible
   progress rather than restarting the operation.
3. Navigate to Tasks. The board has To Do, In Progress, and Completed columns. Pick one
   "Write content" ticket in this order:
   - First, a write-content ticket in In Progress (it shows a Continue button). This is a
     ticket whose article work already started; resume it rather than starting another.
   - Otherwise, the first write-content ticket in To Do (it shows a Write Article button).
   Never select a ticket from Completed, Done, Published, or Archived, even if it still
   appears in the task list. Do not create a new ticket.
4. Open the chosen ticket and verify it is not completed or published before acting. If it
   is, ignore it and continue searching In Progress and then To Do.
5. If Research is incomplete, complete or wait for the Research stage. If Research is already
   complete, preserve it and continue.
6. If Outline is incomplete, complete the Outline stage. If Outline is already complete,
   preserve it and continue.
7. If the article draft is not written yet, click the "Write Article" button exactly once
   (this moves the ticket to In Progress, which is expected) and wait for the full article
   body to be generated and visible on the ticket. Allow up to 10 minutes, checking visible
   progress rather than clicking again. If the article is already written, preserve it and
   continue. Do not edit the generated text.
8. Do not click Publish Article, do not submit publication, and do not make any irreversible
   publishing change. Stop immediately after the article draft exists and before publishing.
9. Return the current ticket page URL, the article title, a concise summary of the written
   article, and the completion state of research, outline, article draft, and publishing.

Important behavior:
- Reuse Research, Outline, and Write Article work already complete on the selected
  ticket; never restart a completed stage, click Write Article more than once, select a
  completed-stack ticket, or duplicate a ticket.
- Research may take up to 5 minutes and article writing up to 10 minutes. Use generous waits
  and inspect visible progress after each wait.
- If no eligible In Progress or To Do write-content ticket exists, return the current Gauge URL, use "No article found"
  as the title, use a concise "No open write-content ticket was found" summary, and explain
  that no ticket was found.

Output:
- ticket_url (string)
- article_title (string)
- article_summary (string)
- research_completed (boolean)
- outline_completed (boolean)
- article_written (boolean)
- published (boolean): must remain false
- message (string)`,
};

export const gaugePublishArticle: TaskDefinition<string> = {
  name: 'gauge-publish-article',
  description: 'Publish a Gauge content ticket with a selected thumbnail.',
  aiFallback: true,
  longRunning: true,
  inputSchema: [
    { name: 'ticket_url', type: 'string', description: 'Gauge ticket URL' },
    { name: 'article_title', type: 'string', description: 'Article title' },
    { name: 'destination', type: 'string', description: 'blogs, templates hubs, or guides' },
    { name: 'author', type: 'string', description: 'Required author name' },
    { name: 'thumbnail_file', type: 'file', description: 'Selected article thumbnail' },
  ],
  outputSchema: [
    { name: 'article_url', type: 'string', description: 'The newly published article URL' },
    { name: 'published', type: 'boolean', description: 'Whether publishing completed' },
    { name: 'message', type: 'string', description: 'Concise publish result' },
  ],
  parse: (output) => {
    const reason = typeof output.message === 'string' ? output.message : 'no reason returned';
    if (!bool(output, 'published')) {
      throw new Error(`Gauge publish task did not publish: ${reason}`);
    }
    if (typeof output.article_url !== 'string' || !output.article_url) {
      throw new Error(`Gauge publish task published but returned no URL: ${reason}`);
    }
    return output.article_url;
  },
  steps: [
    {
      name: 'prepare',
      outputSchema: [{ name: 'ready', type: 'boolean', description: 'Whether the publish dialog is ready' }],
      prompt: `Objective:
Open one Gauge content ticket and get its publish dialog ready. Do not publish anything.

Inputs:
- ticket_url: {{ticket_url}}
- destination: {{destination}} (exactly one of blogs, templates hubs, guides)
- author: {{author}}

Steps:
1. Navigate directly to the ticket URL as the first action. The ticket URL is authoritative;
   it does not matter whether the board shows it under To Do or In Progress.
2. If the ticket is already published, stop with ready=false and say so.
   If the ticket still offers Write Article, click it once and wait up to 10 minutes for the
   article body to appear.
3. Click Publish Article to open the "Publish to Webflow" dialog.
4. Select the destination card matching the destination input.
5. In Additional fields, set Author to the author input and choose the most relevant existing
   Tag for the article. Never create a new tag and never pick an unrelated one.
6. Leave the Thumbnail field alone: the next step fills it in, so do not click Choose image.
7. Leave the dialog open and finish with ready=true.

Output:
- ready (boolean): true only when the dialog is open with destination, author and tag set`,
    },
    {
      name: 'upload-thumbnail',
      outputSchema: [{ name: 'thumbnail_uploaded', type: 'boolean', description: 'Whether the preview appeared' }],
      code: `async (page, parameters) => {
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ timeout: 15000 });

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    dialog.getByRole('button', { name: 'Choose image' }).click(),
  ]);
  await chooser.setFiles(parameters.thumbnail_file);

  const field = dialog.locator('p:text-is("Thumbnail")').locator('xpath=ancestor::div[2]');
  await field.locator('img').first().waitFor({ timeout: 60000 });
  return { thumbnail_uploaded: true };
}`,
      prompt: `The "Publish to Webflow" dialog is open. Look at the Thumbnail field under Additional fields.
If it shows an image preview with a filename under it, return thumbnail_uploaded=true.
Otherwise return thumbnail_uploaded=false. Do not try to upload anything yourself and do not
click Publish Now.`,
    },
    {
      name: 'publish',
      prompt: `Objective:
Publish the article from the "Publish to Webflow" dialog that is already open, exactly once.

Inputs:
- article_title: {{article_title}}
- thumbnail_uploaded: {{thumbnail_uploaded}}

Steps:
1. If thumbnail_uploaded is false, or the Thumbnail field shows no image preview, stop without
   publishing and return published=false with a message.
2. Review the dialog, then click Publish Now exactly once.
3. Wait for the published article URL. Open it and follow any redirect. The public canonical
   host is anchorbrowser.io, so do not return a www.anchorbrowser.com redirect URL.
4. Return the final canonical article URL with published=true.

Safety:
- Never click Publish Now more than once.
- If the article was published but the URL cannot be found, return published=true with an
  empty article_url and explain in the message.

Output:
- article_url (string)
- published (boolean)
- message (string)`,
    },
  ],
};

export const searchConsoleRequestIndexing: TaskDefinition<{ requested: boolean; message: string }> = {
  name: 'search-console-request-indexing',
  description: 'Request Google Search Console indexing for a published article URL.',
  aiFallback: true,
  inputSchema: [
    { name: 'article_url', type: 'string', description: 'Published article URL' },
    { name: 'property', type: 'string', description: 'Search Console URL-prefix property', required: false },
  ],
  outputSchema: [
    { name: 'indexing_requested', type: 'boolean', description: 'Whether indexing was requested' },
    { name: 'message', type: 'string', description: 'Concise indexing result' },
  ],
  parse: (output) => ({
    requested: bool(output, 'indexing_requested'),
    message: str(output, 'message'),
  }),
  code: `async (page, parameters) => {
  const property = parameters.property || 'https://anchorbrowser.io/';
  await page.goto(
    'https://search.google.com/search-console/inspect' +
      '?resource_id=' + encodeURIComponent(property) +
      '&id=' + encodeURIComponent(parameters.article_url),
    { waitUntil: 'domcontentloaded' },
  );

  const verdict = page.getByText(/URL is (on|not on|unknown to) Google/).first();
  await verdict.waitFor({ timeout: 120000 });
  const verdictText = ((await verdict.textContent()) || '').trim();
  if (verdictText.startsWith('URL is on Google')) {
    return { indexing_requested: true, message: verdictText + '; no request needed' };
  }

  await page.getByRole('button', { name: 'Request indexing' }).click();
  const outcome = page
    .getByText(/Indexing requested|already been requested|Quota exceeded|request rejected/i)
    .first();
  await outcome.waitFor({ timeout: 180000 });
  const message = ((await outcome.textContent()) || '').trim();
  await page.getByRole('button', { name: /Got it|OK/i }).click({ timeout: 5000 }).catch(() => {});

  return { indexing_requested: /Indexing requested|already been requested/i.test(message), message };
}`,
  prompt: `Objective:
Request indexing for one newly published article in Google Search Console.

Start URL:
https://search.google.com/search-console

Input:
- URL to inspect: {{article_url}}
- Search Console property: {{property}} (when blank or null, use https://anchorbrowser.io/)

Steps:
1. Wait for the Search Console page to finish loading. Do not use the browser address bar
   for inspection.
2. Select the Search Console property above. Do not inspect the URL under a different
   property. If that property is unavailable, return indexing_requested=false and explain
   that the property is not available.
3. Find the page's URL inspection field. It is the wide field at the top of the Search Console
   page whose placeholder or accessible label contains "Inspect any URL" or "Inspect URL".
4. Click that inspection field, enter the exact URL to inspect, and submit it with Enter or
   the field's Inspect/Run inspection control.
5. Wait until the URL inspection result is fully loaded.
6. If the result says the URL is already on Google or an indexing request is already pending,
   return indexing_requested=true with that status and do not submit a duplicate request.
7. Otherwise click Request indexing, wait for the confirmation dialog, click the confirmation
   control once, and wait for the request accepted/completed message.
8. Return whether the indexing request was accepted and a concise message. If the inspection
   field or Request indexing control cannot be found, return indexing_requested=false with a
   precise failure message.

Output:
- indexing_requested (boolean)
- message (string)`,
};
