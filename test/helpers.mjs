import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

/** Create a temporary git repo with one commit on `main`. Returns its path. */
export async function makeTempRepo(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'branchspace-test-')))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  await git(['init', '-b', 'main'], dir)
  await git(['config', 'user.email', 'test@example.com'], dir)
  await git(['config', 'user.name', 'Test'], dir)
  await writeFile(join(dir, 'README.md'), '# test\n')
  await git(['add', '.'], dir)
  await git(['commit', '-m', 'init'], dir)
  return dir
}

export async function writeRepoFile(dir, rel, content) {
  await mkdir(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
  await writeFile(join(dir, rel), content)
}
