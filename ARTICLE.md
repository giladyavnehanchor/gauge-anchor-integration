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

- An **identity** is a persistent, authenticated browser profile for one application. You log in once (Gauge, Google), Anchor keeps the session alive, and every future browser session can start already logged in.
- A **task** is a reusable automation generated from a plain-language prompt. You describe the flow once, Anchor explores the site and compiles it into a runnable task with a typed input and output schema. Then you call it like a function.

So instead of reverse-engineering three different products, we wrote four prompts.

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
  return draft;
}
```

Four steps. Check that we are still logged in to Gauge. Ask Gauge for the next article to write and get it through research and outline. Generate thumbnail options and save a draft. Post it to Slack for a human to approve.

And here is publishing, which fires when someone clicks **Post** in that Slack message:

```ts
export async function publish(app: App, draftId: string, choice: PublishChoice): Promise<PublishResult> {
  const draft = await loadPublishableDraft(app, draftId);
  if (draft.status === 'published') return publishedResult(draft);
  const thumbnail = await loadThumbnail(app, draft, choice.thumbnailPath);

  inFlight.add(draft.id);
  try {
    const searchConsole = await requireIdentity(app, 'search-console');
    const articleUrl = await publishArticle(app, draft, choice.destination, thumbnail);
    const indexing = await requestIndexing(app, searchConsole, articleUrl);
    return markPublished(app, draft, articleUrl, indexing);
  } finally {
    inFlight.delete(draft.id);
  }
}
```

Check that we are still logged in to Google. Publish the article through Gauge with the chosen thumbnail and destination. Ask Search Console to index the new URL. Record the result so a second click cannot publish twice.

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
  name: 'gauge-content-research-outline',
  description: 'Research and outline an open Gauge write-content ticket without publishing.',
  aiFallback: true,
  longRunning: true,
  inputSchema: [],
  outputSchema: [
    { name: 'ticket_url', type: 'string', description: 'URL of the selected write-content ticket' },
    { name: 'article_title', type: 'string', description: 'Title of the article from the content ticket' },
    { name: 'article_summary', type: 'string', description: 'Concise summary of the article content' },
    { name: 'research_completed', type: 'boolean', description: 'Whether research is complete' },
    { name: 'outline_completed', type: 'boolean', description: 'Whether outline is complete' },
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
      message: str(output, 'message'),
    };
  },
  prompt: `Objective:
Process one currently open Gauge "write content" ticket through research and outline,
then stop before publishing the article. The task must be safe to rerun when some stages
are already complete.

Steps:
1. Navigate to Triage. If a Generate Now action is available and has not already been
   completed for the current triage item, click Generate Now once. If it got tasks pending,
   click accept on all of them until there are no more.
2. Wait generously for Gauge research to finish: allow up to 5 minutes, checking visible
   progress rather than restarting the operation.
3. Navigate to Tasks and open the Todo section. Find an open ticket whose task is to write
   content. Never select a ticket from Completed, Done, Published, or Archived.
...
7. Do not click Publish Article. Stop immediately before publishing.
...`,
};
```

The prompt is the program. It reads like the instruction you would give a new teammate, including the things you would say twice because they matter: *do not restart research that is already running*, *never pick a ticket from a completed stack*, *stop before publishing*. Anchor turns that into a browser automation; we never wrote a selector.

The other three follow the same pattern:

- `authCheck(target)` is a tiny, deterministic DOM check (`aiFallback: false`) that answers one question: does this page look logged in? We run it before every expensive task so that a stale session fails in ten seconds with a re-auth link, not in twenty minutes with a confused agent.
- `gaugePublishArticle` takes the ticket URL, destination, author, and a thumbnail **file** as inputs, opens the publish dialog, sets everything, uploads the image, clicks *Publish Now* exactly once, and returns the final canonical article URL.
- `searchConsoleRequestIndexing` takes an article URL, picks the right property, pastes the URL into the inspection field, and clicks *Request indexing* unless Google says the page is already indexed or a request is pending.

## Running a task

The client code that runs any of those is generic and short. Create a browser session that is already logged in as the identity, make sure the task exists (generate it from the prompt on first use, reuse it afterwards), run it synchronously, parse the result, close the session:

```ts
async runTask<TOutput>(task: TaskDefinition<TOutput>, options: RunTaskOptions): Promise<TOutput> {
  const timeoutMs = task.longRunning ? this.config.longTaskTimeoutMs : this.config.taskTimeoutMs;
  const sessionId = await this.createSession(options.identityId);
  try {
    const taskId = await this.ensureTask(task, options.applicationId, options.identityId, timeoutMs);
    const path = `/v2/tasks/${encodeURIComponent(taskId)}/run`;
    const inputs = options.inputs ?? {};
    const payload = options.file
      ? await this.requestMultipart(path, {
          session_id: sessionId,
          sync: 'true',
          cleanup_sessions: 'false',
          identity_skip_validation: 'true',
          input_params: JSON.stringify(inputs),
        }, options.file, timeoutMs)
      : await this.request('POST', path, {
          session_id: sessionId,
          input_params: inputs,
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

The only wrinkle worth calling out is the multipart branch. When a task input is a file, the run request becomes `multipart/form-data`, and `input_params` must be sent as a JSON *string* in one form field rather than as individual fields. We learned that from a `400 expected object, received undefined`, and it is the kind of thing a code sample saves you an hour on.

## Identities, and the boring part that makes it work

The reason this holds together unattended is `ensureIdentity`. Every flow starts with it, and it does four things:

1. Find (or create) the Anchor application for the target URL.
2. Pick its identity and read the status Anchor already knows.
3. If the status looks healthy, run the `authCheck` task to confirm the page actually renders logged in.
4. If it is missing or stale, mint a re-authentication link and post it to Slack, once, and remember that we did so we do not spam the channel every two days.

When a Google session finally expires, the person on rotation gets a Slack message with a link, clicks it, logs in inside Anchor's hosted browser, and the next publish just works. Nobody touches a server. Nobody stores a Google password anywhere.

## The human in the loop

We deliberately did not automate the *decision* to publish. Discovery ends in a Slack message with the article title, summary, ticket link, and five generated thumbnail options rendered as buttons. A destination dropdown and a **Post** button sit underneath.

Clicking a thumbnail or picking a destination updates the message in place. Clicking **Post** returns an ephemeral "Publishing started" immediately, then runs `publish()` in the background and reports the article URL and the indexing status back to the channel a few minutes later. The draft is saved to disk with the selected options, so a second click, a retry after a failure, or two people racing each other all resolve to the same single publish.

## Things we got wrong first

**Prompts need to be idempotent.** Our first discovery prompt happily restarted research on a ticket that was already half-done. The fix was not code; it was two sentences in the prompt: *reuse Research and Outline work already complete on the selected ticket; never restart research.* Treat prompts like you treat migrations.

**Say "exactly once" out loud.** The publish prompt contains *click Publish Now exactly once* and *never click it for an already published ticket*. The `parse` function also refuses `published: false` and the code refuses to run at all if the draft already has an article URL. Belt, braces, and a third belt.

**Check the login before the long task.** A stale session inside a 20-minute research task fails slowly and ambiguously. A 10-second DOM check fails fast with a precise reason. Run the cheap check first, every time.

**Give the browser time.** Gauge's research step can legitimately take five minutes. The prompt says so, and the task timeout is 30 minutes. Timeouts tuned for API calls will kill perfectly healthy browser automations.

## What it took

About 2,300 lines of TypeScript including tests, with the four prompts accounting for a good chunk of that. No Playwright scripts, no selectors, no headless browser on our server. The whole service is a small Express app on a single EC2 instance with a systemd timer for discovery and Caddy in front for the Slack callback URL. Anchor runs the browsers.

The lesson we keep coming back to: the best tools in your stack will expose 90% of what you need through an API or an MCP server, and you should absolutely use that 90%. The remaining 10% is the last mile, and it lives in a browser. Now that browsers are something you can hand a paragraph of instructions to, that last mile is an afternoon, not a project.

The code is on GitHub at [giladyavnehanchor/gauge-anchor-integration](https://github.com/giladyavnehanchor/gauge-anchor-integration).
