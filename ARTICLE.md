# The Last Mile of Content Automation: Four Prompts, Two Logins, One Slack Button

*How we used Anchor Browser to close the gaps between a great content tool and our actual publishing workflow, in about 2,000 lines of TypeScript.*

---

We publish a lot of technical content at Anchor. Blog posts, guides, template hubs. For a while the bottleneck was not writing; it was everything around writing. Picking the next topic, kicking off research, generating an outline, choosing a thumbnail, publishing to the right section of the site, and then telling Google the page exists.

A few months ago we started using [Gauge](https://www.withgauge.com) for the content side of that, and it quietly removed most of the pain. This post is about the part it did not remove, and how we automated it in an afternoon with a browser, four prompts, and a Slack button.

## First, some love for Gauge

Gauge is very good at what it does. It watches how our brand shows up across AI search and traditional SEO, turns that into a triage queue of content opportunities, and then walks each one through research, outline, draft, and publish. It has a CMS integration that pushes finished articles to our site. And it ships an MCP server that exposes almost all of this to an agent: topics, prompts, the content library, the action board, the whole pipeline from brief to published article.

If you are building an agent that needs to *reason* about your content strategy, Gauge's MCP is where you should start. We use it constantly.

But an MCP server exposes what the product team decided to expose, and a product team cannot anticipate every workflow. We ran into three small, stubborn gaps that were specific to how *we* work:

1. **The triage loop.** Gauge's Triage view has a "Generate Now" button and, after it runs, a set of suggested tasks you accept one by one. That click-accept-repeat sequence is a UI flow. We wanted it to happen on a schedule without a human in the loop.
2. **Publishing with our house rules.** When a ticket is ready, we publish it to a specific destination (blogs, guides, or template hubs), under a specific author, with an existing tag, and with a custom thumbnail uploaded from a file. Most of those knobs live in the publish dialog, not in an API.
3. **"Request indexing" in Google Search Console.** After publishing, we want Google to crawl the page now, not whenever. Search Console's URL Inspection API can tell you whether a URL is indexed, but the *Request indexing* button has no public API. It is a button in a web app behind a Google login, and that is all it will ever be.

None of these are Gauge's fault. Two of them are not even Gauge's product. They are just the last mile: the bits of a workflow that live in a browser tab because that is where the vendor put them.

## Why a browser

We build [Anchor Browser](https://anchorbrowser.io), so you can guess where this goes. But the reason is more specific than "we had a hammer".

The three gaps share a shape. Each one is a logged-in web UI, each has a small deterministic sequence of clicks, and each is something you would happily hand to a competent new hire with a one-paragraph instruction. That shape is exactly what Anchor's **identities** and **tasks** are for:

- An **identity** is a persistent, authenticated browser profile for one application. You log in once (Gauge, Google), Anchor keeps the session alive, and every future browser session can start already logged in. Onboarding is dynamic: point Anchor at a URL and it creates the application, mints a one-time login link you can hand to whoever owns the account, and monitors the session's health from then on. When the session eventually expires, Anchor gives you a re-auth link instead of a stack trace.
- A **task** is a reusable automation. You can generate one from a plain-language prompt, and Anchor will explore the site itself and compile the flow into a versioned task with a typed input and output schema. Or, when you already know the exact clicks, you can hand it your own Playwright code and keep the agent as a fallback. Either way you call it like a function, and every run leaves behind a recording, logs, and a structured result.

The word we kept using internally was *reliable*. A generated task is not an LLM improvising in a browser on every run; it is compiled once, versioned, and replayed, with the agent stepping in only when the page does not match what the task expects. That is what made it reasonable to run this unattended on a timer.

So instead of reverse-engineering three different products, we wrote four prompts and, for the simplest step, twenty-five lines of Playwright.

## The whole thing, from the top

Here is the discovery flow. It runs every two days from a systemd timer, or on demand from a Slack button:

```ts
export async function discover(app: App): Promise<DiscoveryDraft | undefined> {
  const gauge = await ensureIdentity(app, 'gauge');
  if (!gauge) return undefined;

  const article = await findArticleToWrite(app, gauge);
  if (!article) return undefined;

  const draft = await prepareDraft(app, gauge, article);
  await sendDraftToSlack(app, draft);
  return scheduleAutoPublish(app, draft);
}
```

Five steps. Check that we are still logged in to Gauge. Ask Gauge for the next article to write and get it through research, outline, and the written draft. Generate thumbnail options and save a draft. Post it to Slack for a human to approve. Start a fifteen-minute countdown, in case nobody does.

And here is publishing, which fires when someone clicks **Post** in that Slack message:

```ts
export async function publish(app: App, draftId: string, choice: PublishChoice): Promise<PublishResult> {
  const draft = await loadDraft(app, draftId);
  if (draft.status === 'published') return publishedResult(draft);
  const thumbnail = await loadThumbnail(app, draft, choice.thumbnailPath);

  inFlight.add(draft.id);
  try {
    const gauge = await requireIdentity(app, 'gauge');
    const articleUrl = await publishArticle(app, draft, gauge, choice.destination, thumbnail);
    const indexing = await requestIndexing(app, articleUrl);
    return markPublished(app, draft, articleUrl, indexing);
  } finally {
    inFlight.delete(draft.id);
  }
}
```

Check that we are still logged in to Gauge. Publish the article through Gauge with the chosen thumbnail and destination. Ask Search Console to index the new URL. Record the result so a second click cannot publish twice.

Each step depends only on the identity it actually uses. Publishing needs Gauge, so a Gauge session that has expired stops it cold. Indexing needs Google, so if the Google session has expired, `requestIndexing` does not throw: the article is already live, and failing the whole publish over a step that has nothing to do with Gauge would be wrong. Instead it returns `requested: false` with the reason, the identity monitor posts its usual re-authentication link, and the Slack result message grows a **Request indexing** button that runs just that one step once someone has logged back in.

Everything interesting is inside those `findArticleToWrite`, `publishArticle`, and `requestIndexing` calls, and each of them is a single line:

```ts
const article = await app.anchor.runTask(gaugeFindArticle, {
  applicationId: gauge.application.id,
  identityId: gauge.identityId,
});
```

## The four tasks

All four automations live in one file, `src/tasks.ts`. Each is a plain object: a name, a description, the prompt, an input and output schema, and a `parse` function that turns the task's JSON output into a typed value. This is the one for discovery, trimmed:

```ts
export const gaugeFindArticle: TaskDefinition<Article | null> = {
  name: 'gauge-content-research-outline-draft',
  description: 'Research, outline, and draft an open Gauge write-content ticket without publishing.',
  aiFallback: true,
  longRunning: true,
  inputSchema: [],
  outputSchema: [
    { name: 'ticket_url', type: 'string', description: 'URL of the selected write-content ticket' },
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

Steps:
1. Navigate to Triage. If a Generate Now action is available and has not already been
   completed for the current triage item, click Generate Now once. If it got tasks pending,
   click accept on all of them until there are no more.
2. Wait generously for Gauge research to finish: allow up to 5 minutes, checking visible
   progress rather than restarting the operation.
3. Navigate to Tasks. Pick one "Write content" ticket: first a ticket in In Progress (its
   article work already started; resume it), otherwise the first one in To Do. Never select
   a ticket from Completed, Done, Published, or Archived.
...
7. If the article draft is not written yet, click the "Write Article" button exactly once and
   wait for the full article body to be generated. Allow up to 10 minutes.
8. Do not click Publish Article. Stop immediately after the draft exists and before publishing.
...`,
};
```

The prompt is the program. It reads like the instruction you would give a new teammate, including the things you would say twice because they matter: *do not restart research that is already running*, *never pick a ticket from a completed stack*, *stop before publishing*. Anchor turns that into a browser automation; we never wrote a selector.

Because the prompt is the program, editing it has to redeploy the task. `ensureTask` stamps a short hash of the prompt and schemas into the generated task's description, and regenerates the task the next time it runs with a different hash. Step 3 above went through exactly that: our first version only looked in To Do, and the moment *Write Article* moved a ticket to In Progress the next discovery run would have started a second one. Fixing it was a prompt edit and a commit.

The other three follow the same pattern:

- `authCheck(target)` is a tiny, deterministic DOM check (`aiFallback: false`) that answers one question: does this page look logged in? We run it before every expensive task so that a stale session fails in ten seconds with a re-auth link, not in twenty minutes with a confused agent.
- `gaugePublishArticle` takes the ticket URL, destination, author, and a thumbnail **file** as inputs, opens the publish dialog, sets everything, uploads the image, clicks *Publish Now* exactly once, and returns the final canonical article URL. It is three steps rather than one prompt, for a reason we get to below.
- `searchConsoleRequestIndexing` takes an article URL, opens URL Inspection for it, and clicks *Request indexing* unless Google says the page is already indexed. This one is different from the other three, and it deserves its own section.

## When you already know the clicks

Search Console is the simplest of our three gaps: one deep link, one verdict to read, one button to click. It would be a waste to have an agent rediscover that every time. So for this task we wrote the browser code ourselves and let Anchor run it.

An Anchor task is, under the hood, a **workflow**: a graph of segments where each segment carries both an agent prompt and an optional deterministic Playwright function. When a segment runs, the code goes first. Only if it throws does the agent take over, using the prompt. We can author that format directly. The task definition gains one field, `code`:

```ts
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
  parse: (output) => ({ requested: bool(output, 'indexing_requested'), message: str(output, 'message') }),
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

Input:
- URL to inspect: {{article_url}}
- Search Console property: {{property}} (when blank or null, use https://anchorbrowser.io/)
...`,
};
```

The `page` is a regular Playwright page already inside the logged-in Google session, and `parameters` are the task inputs by name. The function returns the output record. That is the entire contract.

Uploading it is a few lines in the client. We wrap the function in a one-segment workflow and create the task from code instead of from a prompt:

```ts
export function workflowCode(task: TaskDefinition<unknown>): string {
  const steps = task.steps ?? [{ name: 'main', prompt: task.prompt, code: task.code }];
  return JSON.stringify({
    name: task.name,
    inputParameters: parameters(task.inputSchema),
    outputParameters: parameters(task.outputSchema),
    startSegmentName: steps[0].name,
    segments: steps.map((step, index) => {
      const next = steps[index + 1];
      const previousOutputs = steps.slice(0, index).flatMap((earlier) => earlier.outputSchema ?? []);
      return {
        name: step.name,
        type: step.code ? 'ui' : 'agent',
        prompt: step.prompt,
        inputParameters: parameters([...task.inputSchema, ...previousOutputs]),
        outputParameters: parameters(next ? step.outputSchema ?? [] : task.outputSchema),
        deterministic: step.code ?? null,
        next: next?.name ?? null,
        router: null,
      };
    }),
  });
}
```

```ts
private async createCodeTask(task: TaskDefinition<unknown>, applicationId: string): Promise<string> {
  const body = await this.request('POST', '/task', {
    name: task.name,
    description: task.description,
    language: 'workflow',
    code: Buffer.from(workflowCode(task), 'utf8').toString('base64'),
    application_id: applicationId,
    ai_fallback_enabled: task.aiFallback,
  });
  const taskId = stringField(body, 'id', `${task.name} creation`);
  await this.request('POST', `/v2/tasks/${taskId}/publish-draft`, {});
  return taskId;
}
```

Three things we like about this arrangement:

- **The repo is the source of truth.** Before reusing an existing task, the client fetches its code and compares it to what is in `tasks.ts`. If we edit the function, the next run recreates the task. No dashboard drift.
- **The prompt is still there.** With `aiFallback: true`, if Google redesigns the inspection page and our selectors stop matching, the code throws and the agent finishes the job using the prompt, with the same typed inputs and outputs. We saw exactly this during testing: an expired Google session sent the deep link to a sign-in page, the deterministic function timed out, and the agent took over and reported precisely what blocked it. One note for hand-written fallback prompts: the agent sees your inputs through `{{name}}` placeholders, so write `{{article_url}}` rather than "the article URL".
- **Failures produce fixes.** When a deterministic segment fails, Anchor captures the page state and execution logs and proposes a corrected draft version of the task. You review and publish the draft; nothing changes under you.

Same `runTask` call, same identity, same Slack message at the end. The only difference is who wrote the clicks.

## Mixing the two in one task

`workflowCode` above already handles more than one step, and the publish task is why. Most of publishing is judgment: pick the right destination card, find the author, choose the most relevant existing tag, read the final URL off whatever the app shows after the click. That is agent work. One step in the middle is not: Gauge's *Thumbnail* field is a plain `<button>Choose image</button>` with no `<input type="file">` anywhere near it. Clicking it creates the input on the fly and opens the operating system's file picker. An agent has nothing in the DOM to hand a file to, and no picker to click through. It cannot upload that image, however well you describe the field.

Playwright can, because it sits below the page: it intercepts the picker itself. So the task is three steps that share one browser session, and the file chooser is the only thing we wrote by hand:

```ts
export const gaugePublishArticle: TaskDefinition<string> = {
  name: 'gauge-publish-article',
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
  steps: [
    {
      name: 'prepare',
      outputSchema: [{ name: 'ready', type: 'boolean', description: 'Whether the publish dialog is ready' }],
      prompt: `Open the ticket at {{ticket_url}}, click Write Article if the draft is not written yet,
open the "Publish to Webflow" dialog, select the {{destination}} card, set Author to {{author}},
choose the most relevant existing Tag. Leave the Thumbnail field alone. Finish with ready=true.`,
    },
    {
      name: 'upload-thumbnail',
      outputSchema: [{ name: 'thumbnail_uploaded', type: 'boolean', description: 'Whether the preview appeared' }],
      code: `async (page, parameters) => {
  const dialog = page.getByRole('dialog').first();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    dialog.getByRole('button', { name: 'Choose image' }).click(),
  ]);
  await chooser.setFiles(parameters.thumbnail_file);

  const field = dialog.locator('p:text-is("Thumbnail")').locator('xpath=ancestor::div[2]');
  await field.locator('img').first().waitFor({ timeout: 60000 });
  return { thumbnail_uploaded: true };
}`,
      prompt: `Look at the Thumbnail field. Return thumbnail_uploaded=true only if it shows an image
preview with a filename under it. Do not try to upload anything yourself.`,
    },
    {
      name: 'publish',
      prompt: `If thumbnail_uploaded is false or the Thumbnail field shows no preview, stop with
published=false. Otherwise click Publish Now exactly once, wait for the article URL, open it,
follow redirects, and return the final anchorbrowser.io URL with published=true.`,
    },
  ],
  parse: (output) => { /* published must be true and article_url present */ },
};
```

A `file` input arrives in the code step as a path on disk, so `chooser.setFiles(parameters.thumbnail_file)` is the whole upload. Each step sees the task inputs plus the outputs of the steps before it, which is how `publish` gets to check `thumbnail_uploaded` before it touches the button. And because the step with code still carries a prompt, a broken selector degrades to an agent that reports honestly rather than a run that silently ships without an image.

## Running a task

The client code that runs any of those is generic and short. Create a browser session that is already logged in as the identity, make sure the task exists (generate it from the prompt or upload it from code on first use, reuse it afterwards), run it synchronously, parse the result, close the session:

```ts
async runTask<TOutput>(task: TaskDefinition<TOutput>, options: RunTaskOptions): Promise<TOutput> {
  const timeoutMs = task.longRunning ? this.config.longTaskTimeoutMs : this.config.taskTimeoutMs;
  const sessionId = await this.createSession(options.identityId);
  try {
    const taskId = await this.ensureTask(task, options.applicationId, options.identityId, timeoutMs);
    const payload = await this.request('POST', `/v2/tasks/${encodeURIComponent(taskId)}/run`, {
      session_id: sessionId,
      input_params: { ...options.inputs, ...fileInputs(options.files) },
      sync: true,
      cleanup_sessions: false,
    }, timeoutMs);

    const run = record(payload, `${task.name} run`);
    if (run.status !== undefined && run.status !== 'success') {
      throw new Error(typeof run.error === 'string' ? run.error : `${task.name} ended with status ${String(run.status)}`);
    }
    const output = unwrapTaskOutput(run.result ?? run.output ?? run, task.outputSchema.map((field) => field.name));
    return task.parse(output);
  } finally {
    await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined);
  }
}
```

`fileInputs` is there because one of our tasks takes a file. A file input is just another entry in `input_params`: a base64 data URI with the filename in its header (`data:image/png;name=thumb.png;filename=thumb.png;base64,...`). Anchor decodes it, uploads it into the browser session, and the task attaches it to the publish dialog like a human would. One JSON request, no multipart.

## Identities, and the boring part that makes it work

The reason this holds together unattended is `ensureIdentity`. Every flow starts with it, and it does four things:

1. Find (or create) the Anchor application for the target URL.
2. Pick its identity and read the status Anchor already knows.
3. If the status looks healthy, run the `authCheck` task to confirm the page actually renders logged in.
4. If it is missing or stale, mint a re-authentication link and post it to Slack, once, and remember that we did so we do not spam the channel every two days.

When a Google session finally expires, the person on rotation gets a Slack message with a link, clicks it, logs in inside Anchor's hosted browser, and the next publish just works. Nobody touches a server. Nobody stores a Google password anywhere. Adding a third application is one more `target(...)` line in the config: a key, a label, and a URL. Anchor does the rest.

## The human in the loop

We kept a human within reach of the *decision* to publish. Discovery ends in a Slack message with the article title, summary, ticket link, and five generated thumbnail options rendered as buttons. A destination dropdown and a **Post** button sit underneath.

Clicking a thumbnail or picking a destination updates the message in place. Clicking **Post** returns an ephemeral "Publishing started" immediately, then runs `publish()` in the background and reports the article URL and the indexing status back to the channel a few minutes later. The draft is saved to disk with the selected options, so a second click, a retry after a failure, or two people racing each other all resolve to the same single publish.

The pipeline is fully automated end to end: if nobody reacts within fifteen minutes, the article goes out to the blog with the first thumbnail, and Slack is told it happened automatically. The message is there so a human can interrupt, not so they have to approve.

## Things we got wrong first

**Prompts need to be idempotent.** Our first discovery prompt happily restarted research on a ticket that was already half-done. The fix was not code; it was two sentences in the prompt: *reuse Research and Outline work already complete on the selected ticket; never restart research.* Treat prompts like you treat migrations.

**Say "exactly once" out loud.** The publish prompt contains *click Publish Now exactly once* and *never click it for an already published ticket*. The `parse` function also refuses `published: false` and the code refuses to run at all if the draft already has an article URL. Belt, braces, and a third belt.

**Look at the DOM before you rewrite the prompt.** Our first publish prompt said "upload the thumbnail", and the dialog never showed a preview. We spent two rounds sharpening the prompt: name the field, mention the "Max 4MB" label, warn about the chat attachment button behind the dialog, demand the preview before *Publish Now*. The agent obeyed every word and still could not do it, because the field has no file input for it to use; the only file inputs on the page belong to the chat, so every attempt landed there. One `document.querySelectorAll('input[type=file]')` in the live session told us more than both prompt rewrites. When an agent keeps failing at a single click, check whether that click is possible from inside the page at all; if not, that is your one deterministic step, not a prompting problem.

**Check the login before the long task.** A stale session inside a 20-minute research task fails slowly and ambiguously. A 10-second DOM check fails fast with a precise reason. Run the cheap check first, every time.

**Give the browser time.** Gauge's research step can legitimately take five minutes. The prompt says so, and the task timeout is 30 minutes. Timeouts tuned for API calls will kill perfectly healthy browser automations.

## What it took

About 2,300 lines of TypeScript including tests, with the four prompts accounting for a good chunk of that. Two Playwright functions, one by choice for the step where we knew the clicks and one by necessity for a file picker no agent can reach. No headless browser on our server. The whole service is a small Express app on a single EC2 instance with a systemd timer for discovery and Caddy in front for the Slack callback URL. Anchor runs the browsers, keeps the logins alive, and versions the automations.

The lesson we keep coming back to: the best tools in your stack will expose 90% of what you need through an API or an MCP server, and you should absolutely use that 90%. The remaining 10% is the last mile, and it lives in a browser. Now that browsers are something you can hand a paragraph of instructions to, that last mile is an afternoon, not a project.

The code is on GitHub at [giladyavnehanchor/gauge-anchor-integration](https://github.com/giladyavnehanchor/gauge-anchor-integration).
