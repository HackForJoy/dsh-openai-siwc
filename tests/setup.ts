// Point every DSH home-relative path at a throwaway directory so no test can
// touch the developer's real ~/.dsh, even if a store path is misconfigured.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-siwc-home-'))
