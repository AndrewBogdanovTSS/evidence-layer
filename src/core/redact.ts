/**
 * Redaction - what a run printed, with the secrets its environment held taken
 * out before anything hashes, seals or publishes it.
 *
 * The claim it makes falsifiable: "this bundle can be shown to someone." A
 * step's output goes into the bundle as it came, and the bundle goes on from
 * there: into a CI artifact, into a review, with `fold` into a pull request
 * comment. A test that prints its environment on failure, a tool that echoes
 * the registry URL it was given with the token in it - before 0.20.0 that
 * went all the way out, verbatim, under an artifact id that vouched for it.
 *
 * So the values of environment variables whose names say they are secret are
 * replaced, wherever they appear in a captured command line or its output,
 * with `[REDACTED:<NAME>]`.
 * Before the id is computed: the id is an address for what the bundle shows,
 * and a hash of the unredacted text would be a small oracle for the secret.
 *
 * What it deliberately does not do: find a secret by its shape. A pattern for
 * "looks like a key" is a guess that masks commit hashes and misses whatever
 * format came out last month. It knows only what the environment told it, by
 * name - which is also what a CI runner masks in its own log. A secret that
 * reached the output from a file, or under a name that does not say so, is the
 * caller's to remove: `GatherOptions.redact`.
 */

/**
 * A name that says its value is a secret: one of these words as a whole
 * `_`-separated part - so `GITHUB_TOKEN` and `DB_PASSWORD`, but not
 * `GIT_AUTHOR_NAME` or `TOKENIZER_PATH` - or a name ending in `_KEY`.
 * `AWS_ACCESS_KEY_ID` is an identifier, not a secret, and is not one.
 */
const SECRET_NAME_RE = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)(?:_|$)|(?:^|_)KEY$/i

/**
 * Shorter values are left alone: `1`, `true` and `dev` are settings, and
 * replacing every `true` in a test log would redact the log.
 */
export const MIN_SECRET_LENGTH = 8

/** The environment variables whose values are masked, longest value first so one secret inside another is replaced whole. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
  return Object.entries(env)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= MIN_SECRET_LENGTH && SECRET_NAME_RE.test(e[0]))
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length || (a.name < b.name ? -1 : 1))
}

/** `text` with every secret value in `env` replaced by `[REDACTED:<NAME>]`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const { name, value } of secretValues(env)) out = out.split(value).join('[REDACTED:' + name + ']')
  return out
}
