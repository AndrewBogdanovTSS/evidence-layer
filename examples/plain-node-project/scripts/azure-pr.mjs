// Posts to the pull request an Azure Pipelines run is validating - the one
// thing azure-pipelines.yml does that needs the Azure DevOps API, kept out of
// the YAML so the YAML stays readable and this stays testable.
//
//   node scripts/azure-pr.mjs status <job> <pending | $AGENT_JOBSTATUS>
//   node scripts/azure-pr.mjs comment <file>
//
// status: a pull request status, genre `evidence-layer`, named after the job -
// what a status branch policy requires. Statuses carry required-or-not because
// a build validation policy is required or optional for a whole pipeline, and
// the review job must not block a merge the suite allows. It is posted on the
// pull request iteration whose head is the commit this run built, so a status
// about an older push cannot stand for a newer one.
//
// comment: the file as a new thread on the pull request.
//
// What it deliberately does not do: anything outside a pull request build. A
// push to main has no pull request to post to; it says so and exits 0. In
// one, it needs SYSTEM_ACCESSTOKEN mapped from $(System.AccessToken) and the
// project's build service allowed to "Contribute to pull requests". A request
// that fails exits 1 with the status Azure DevOps answered. The token travels
// in a header, never on a command line or into the log.
import { readFileSync } from 'node:fs'

const API = 'api-version=7.1'

function usage(message) {
  console.error('azure-pr: ' + message)
  process.exit(2)
}

const [command, ...args] = process.argv.slice(2)
if (command !== 'status' && command !== 'comment') usage('the command is `status <job> <state>` or `comment <file>`')

// The agent's job status, as $AGENT_JOBSTATUS names it, to the pull request status it means.
const STATES = { pending: 'pending', Succeeded: 'succeeded', SucceededWithIssues: 'succeeded', Failed: 'failed', Canceled: 'error' }
if (command === 'status' && (!/^[a-z][a-z-]*$/.test(args[0] ?? '') || !Object.hasOwn(STATES, args[1] ?? ''))) {
  usage('status needs a job name and one of ' + Object.keys(STATES).join(', ') + ' - got ' + JSON.stringify(args))
}
if (command === 'comment' && args.length !== 1) usage('comment needs one file')

const env = process.env
const pullRequest = env.SYSTEM_PULLREQUEST_PULLREQUESTID
if (!pullRequest) {
  console.log('not a pull request build - there is no pull request to post ' + (command === 'status' ? 'a status' : 'a comment') + ' to')
  process.exit(0)
}
for (const name of ['SYSTEM_ACCESSTOKEN', 'SYSTEM_COLLECTIONURI', 'SYSTEM_TEAMPROJECTID', 'BUILD_REPOSITORY_ID']) {
  // A secret that was never mapped arrives as its own macro, unexpanded.
  if (!env[name] || env[name].startsWith('$(')) usage(name + ' is not set - map it in the step\'s env (SYSTEM_ACCESSTOKEN: $(System.AccessToken))')
}

const collection = env.SYSTEM_COLLECTIONURI.endsWith('/') ? env.SYSTEM_COLLECTIONURI : env.SYSTEM_COLLECTIONURI + '/'
const base =
  collection + encodeURIComponent(env.SYSTEM_TEAMPROJECTID) + '/_apis/git/repositories/' +
  encodeURIComponent(env.BUILD_REPOSITORY_ID) + '/pullRequests/' + encodeURIComponent(pullRequest)

async function call(method, path, body) {
  const res = await fetch(base + path + (path.includes('?') ? '&' : '?') + API, {
    method,
    headers: { Authorization: 'Bearer ' + env.SYSTEM_ACCESSTOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    console.error('azure-pr: ' + method + ' ' + path + ' answered ' + res.status + ' ' + res.statusText)
    process.exit(1)
  }
  return res.json()
}

if (command === 'comment') {
  const content = readFileSync(args[0], 'utf8')
  if (content.trim() === '') {
    console.error('azure-pr: ' + args[0] + ' is empty - nothing to post')
    process.exit(1)
  }
  await call('POST', '/threads', { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1 })
  console.log('posted ' + args[0] + ' to pull request ' + pullRequest)
} else {
  const [job, outcome] = args
  const head = env.SYSTEM_PULLREQUEST_SOURCECOMMITID
  const iterations = (await call('GET', '/iterations')).value ?? []
  const iteration = iterations.find((i) => i.sourceRefCommit?.commitId === head)?.id
  if (iteration === undefined) {
    // Fixed text only: this line is read for logging commands.
    console.log('##vso[task.logissue type=warning]no iteration of this pull request has the commit this run built - the status is posted on the pull request as a whole')
  }
  await call('POST', '/statuses', {
    state: STATES[outcome],
    description: job + ': ' + outcome,
    context: { genre: 'evidence-layer', name: job },
    ...(env.BUILD_BUILDID ? { targetUrl: collection + encodeURIComponent(env.SYSTEM_TEAMPROJECTID) + '/_build/results?buildId=' + encodeURIComponent(env.BUILD_BUILDID) } : {}),
    ...(iteration === undefined ? {} : { iterationId: iteration }),
  })
  console.log('posted evidence-layer/' + job + ' ' + STATES[outcome] + ' to pull request ' + pullRequest + (iteration === undefined ? '' : ', iteration ' + iteration))
}
