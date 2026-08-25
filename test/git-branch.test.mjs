import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBranchName, worktreeDirName } from '../lib/git.js'

const good = ['feature-a', 'main', 'feature/deep-branch', 'fix_123', 'v1.2.3', 'user/name/thing']
const bad = [
  '',
  ' ',
  '..',
  'feature..bad',
  '--starts-with-double-dash',
  '-starts-with-dash',
  'ends-with-slash/',
  '/starts-with-slash',
  'has space',
  'has~tilde',
  'has^caret',
  'has:colon',
  'has?question',
  'has*star',
  'has[bracket',
  'ends.lock',
  'ends-with-dot.',
  '.starts-with-dot',
  'has\\backslash',
  '@{upstream}',
  'control\tchar',
  'a'.repeat(201),
]

test('validateBranchName accepts legal branch names', () => {
  for (const name of good) {
    assert.equal(validateBranchName(name), null, `expected ${name} to be valid`)
  }
})

test('validateBranchName rejects illegal branch names with a reason', () => {
  for (const name of bad) {
    const reason = validateBranchName(name)
    assert.ok(typeof reason === 'string' && reason.length > 0, `expected ${JSON.stringify(name)} to be rejected`)
  }
})

test('worktreeDirName is injective for distinct branches', () => {
  const names = ['a/b', 'a__b', 'a%2Fb', 'a%b', 'plain', 'feature/deep/branch']
  const dirs = names.map(worktreeDirName)
  assert.equal(new Set(dirs).size, names.length, 'directory names must not collide')
  for (const d of dirs) {
    assert.match(d, /^[\w.%-]+$/, `dir name ${d} should be filesystem-safe`)
  }
})

test('worktreeDirName is stable', () => {
  assert.equal(worktreeDirName('feature/x'), worktreeDirName('feature/x'))
})
