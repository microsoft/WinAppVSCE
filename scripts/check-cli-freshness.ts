/**
 * Reports whether the winapp CLI DevTools branch has moved since we last synced.
 *
 * DevTools is still an unmerged branch in another repository, so there is no
 * package version to watch and nothing fails loudly when upstream changes. The
 * only record of what we are built against is schemas/devtools/pinned-cli.json.
 * This compares that pin against the live branch and says how far behind we are.
 *
 * Deliberately local-only and non-failing:
 *   - local, because CI's GITHUB_TOKEN cannot read microsoft/winappCli; wiring
 *     this into a workflow would need a PAT for a cross-repo private read.
 *   - non-failing, because upstream moving is normal and expected. Falling
 *     behind is information, not a defect in this repo's tree.
 *
 * Run it with `npm run check-cli-freshness`. Acting on the result is Pass 1 of
 * .github/skills/devtools-cli-sync/AGENTS.md.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface PinnedCli {
    version: string;
    repository: string;
    branch: string;
    pullRequest: number;
    commit: string;
    runId: number;
    syncedOn: string;
}

const PINNED_PATH = path.join(__dirname, '..', 'schemas', 'devtools', 'pinned-cli.json');
const WORKFLOW_NAME = 'Build and Package';

function gh(args: string[]): unknown | undefined {
    // Deliberately not `shell: true`: the --jq expressions contain spaces and
    // braces, and letting a shell re-parse the concatenated command line
    // mangles them into a request that quietly fails.
    const result = spawnSync('gh', args, { encoding: 'utf-8', timeout: 60_000 });
    if (result.status !== 0 || !result.stdout) {
        return undefined;
    }
    try {
        return JSON.parse(result.stdout);
    } catch {
        return undefined;
    }
}

function fail(message: string): never {
    console.error(`[cli-freshness] ${message}`);
    process.exit(1);
}

const pinned = JSON.parse(fs.readFileSync(PINNED_PATH, 'utf-8')) as PinnedCli;
console.log(
    `[cli-freshness] Pinned to ${pinned.version} (${pinned.repository} ${pinned.branch} @ ${pinned.commit}, run ${pinned.runId}), synced ${pinned.syncedOn}.`,
);

const whoami = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', timeout: 30_000 });
if (whoami.status !== 0) {
    fail('gh is not authenticated. Run `gh auth login` — this check reads a private repository.');
}

const tip = gh([
    'api',
    `repos/${pinned.repository}/commits/${pinned.branch}`,
    '--jq',
    '{sha: .sha, date: .commit.committer.date, message: .commit.message}',
]) as { sha: string; date: string; message: string } | undefined;

if (!tip) {
    fail(`Could not read ${pinned.repository}@${pinned.branch}. Check your access to the repository.`);
}

const short = tip.sha.slice(0, pinned.commit.length);
if (short === pinned.commit) {
    console.log(`[cli-freshness] Up to date: the branch tip is still ${short} (${tip.date}).`);
} else {
    // The compare API counts only commits reachable from the tip, which is the
    // number a reviewer actually has to triage.
    const compare = gh([
        'api',
        `repos/${pinned.repository}/compare/${pinned.commit}...${tip.sha}`,
        '--jq',
        '{ahead: .ahead_by, behind: .behind_by}',
    ]) as { ahead: number; behind: number } | undefined;

    const ahead = compare ? `${compare.ahead} commit(s)` : 'an unknown number of commits';
    console.log(`[cli-freshness] BEHIND by ${ahead}.`);
    console.log(`[cli-freshness]   branch tip ${short} (${tip.date})`);
    console.log(`[cli-freshness]   ${tip.message.split('\n')[0]}`);
    console.log('[cli-freshness] Re-sync with .github/skills/devtools-cli-sync/AGENTS.md.');
}

const run = gh([
    'api',
    `repos/${pinned.repository}/actions/runs?branch=${pinned.branch}&status=success&per_page=20`,
    '--jq',
    `[.workflow_runs[] | select(.name == "${WORKFLOW_NAME}")] | first | {id: .id, sha: .head_sha, date: .created_at}`,
]) as { id: number; sha: string; date: string } | null | undefined;

if (!run) {
    console.log(`[cli-freshness] No successful "${WORKFLOW_NAME}" run found on ${pinned.branch}.`);
} else if (run.id === pinned.runId) {
    console.log(`[cli-freshness] The newest successful build is still run ${run.id} — nothing newer to download.`);
} else {
    console.log(
        `[cli-freshness] A newer successful build exists: run ${run.id} from ${run.sha.slice(0, 8)} (${run.date}).`,
    );
    console.log(
        `[cli-freshness]   gh run download ${run.id} -R ${pinned.repository} -n cli-binaries -D <tmp>`,
    );
}
