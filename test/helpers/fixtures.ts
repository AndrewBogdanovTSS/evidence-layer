/**
 * Recorded host inputs, with their placeholders filled.
 *
 * A placeholder is a JSON string `"__NAME__"` and is replaced by a JSON
 * value, so a path or a patch with quotes or newlines in it still makes valid
 * JSON. Shared, so every host's tests fill fixtures the same way.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOSTS = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'hosts')

export function hostFixture(host: string, name: string, fill: Record<string, string>): string {
  let text = readFileSync(join(HOSTS, host, name), 'utf8')
  for (const [key, value] of Object.entries(fill)) text = text.replaceAll('"__' + key + '__"', JSON.stringify(value))
  return text
}
