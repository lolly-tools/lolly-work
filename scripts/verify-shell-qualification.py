#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Fetch exact main CI qualification and reject newly reported failures."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = 'lolly-tools/lolly'
WORKFLOW = '.github/workflows/ci.yml'
FAST = {'secret history scan', 'typecheck', 'build + bundle budget', 'test (contracts)', 'test (security)',
        'validate catalog', 'smoke (render every tool)', 'opengrep (custom rules + new findings)',
        'deployment scope', 'test (public-ready UI)'}
SHA = re.compile(r'[a-f0-9]{40}')
LIMIT = 32 * 1024**2


class Refusal(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise Refusal(message)


def api(path, binary=False):
    need(path.startswith('repos/' + REPOSITORY + '/'), 'Unexpected provider repository')
    result = subprocess.run(['gh', 'api', '--hostname', 'github.com', path], capture_output=True, timeout=90)
    need(result.returncode == 0 and len(result.stdout) <= LIMIT, 'Bounded GitHub read failed')
    return result.stdout if binary else json.loads(result.stdout)


def collection(path, field, read=api):
    rows, total = [], None
    for page in range(1, 21):
        value = read(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        need(type(value.get('total_count')) is int and 0 <= value['total_count'] <= 2000
             and isinstance(value.get(field), list) and len(value[field]) <= 100, 'Incomplete provider collection')
        need(total is None or total == value['total_count'], 'Provider collection changed during pagination')
        total = value['total_count']; rows.extend(value[field])
        if len(rows) == total:
            need(len({row['id'] for row in rows}) == total, 'Duplicate provider identity')
            return rows
        need(len(rows) < total and len(value[field]) == 100, 'Truncated provider collection')
    raise Refusal('Provider collection exceeds bound')


def validate(q, run, jobs, repository, workflow_id, source, run_id, attempt, tier):
    need(SHA.fullmatch(source) and tier in {'public-ready', 'release-ready'}, 'Exact source and tier required')
    need(q.get('version') == 1 and q.get('status') == 'CI_QUALIFIED'
         and q.get('qualificationTier') == tier and q.get('fullSuiteQualified') is (tier == 'release-ready')
         and q.get('repository') == q.get('headRepository') == REPOSITORY
         and q.get('repositoryId') == repository['id'] and q.get('source') == q.get('headSha') == source
         and q.get('headBranch') == 'main' and q.get('event') == 'push' and q.get('workflow') == WORKFLOW
         and q.get('runId') == run_id and q.get('runAttempt') == attempt
         and q.get('publicationEligible') is True and q.get('knownFailuresRejected') is True
         and q.get('lateFailureCheckRequired') is True and q.get('productionMutation') is False,
         'Qualification provenance or publication boundary differs')
    need(run.get('id') == run_id and run.get('run_attempt') == attempt and run.get('head_sha') == source
         and run.get('path') == WORKFLOW and run.get('workflow_id') == workflow_id
         and run.get('event') == 'push' and run.get('head_branch') == 'main'
         and all(run.get(key, {}).get('id') == repository['id'] and run[key].get('full_name') == REPOSITORY
                 for key in ('repository', 'head_repository')), 'Current provider run differs')
    need((run.get('status') in {'queued', 'in_progress'} and run.get('conclusion') is None)
         or (run.get('status') == 'completed' and run.get('conclusion') == 'success'), 'CI has failed or stopped')
    if tier == 'release-ready':
        need(run.get('status') == 'completed' and run.get('conclusion') == 'success', 'Full CI is still pending')
    else:
        need(q.get('scope', {}).get('publicReadyEligible') is True, 'Change requires full qualification')
    names = {}
    for job in jobs:
        need(job.get('run_id') == run_id and job.get('run_attempt') == attempt and job.get('head_sha') == source
             and isinstance(job.get('name'), str) and job['name'] not in names, 'Job source, attempt or identity differs')
        names[job['name']] = job
        pending = job.get('status') in {'queued', 'in_progress', 'waiting', 'pending'} and job.get('conclusion') is None
        skipped = job.get('status') == 'completed' and job.get('conclusion') == 'skipped' and (
            job['name'] == 'verified instance shell' or (job['name'] == 'public-ready' and q.get('scope', {}).get('publicReadyEligible') is False))
        need(pending or skipped or (job.get('status') == 'completed' and job.get('conclusion') == 'success'),
             'A CI job failed, stopped or unexpectedly skipped: ' + job['name'])
    required = FAST | {tier, 'qualification'}
    need(required <= names.keys() and all(names[name]['status'] == 'completed' and names[name]['conclusion'] == 'success' for name in required),
         'Required qualification checks are not successful')
    recorded = q.get('requiredJobs')
    need(isinstance(recorded, list) and recorded and len({row['name'] for row in recorded}) == len(recorded), 'Required job evidence missing')
    for row in recorded:
        need(row.get('name') in names and row.get('id') == names[row['name']]['id']
             and row.get('conclusion') == names[row['name']]['conclusion'] == 'success', 'Recorded successful job changed')


def verify(request, read=api, require_current=True):
    need(request.get('version') == 1 and request.get('status') == 'QUALIFIED_SHELL_DEPLOYMENT_REQUEST'
         and request.get('repository') == REPOSITORY, 'Unknown deployment request')
    q = request['qualification']; source, run_id, attempt, tier = (q[key] for key in ('source', 'runId', 'runAttempt', 'qualificationTier'))
    need(type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0, 'Exact run and attempt required')
    prefix = 'repos/' + REPOSITORY
    repo = read(prefix + '/'); workflow = read(prefix + '/actions/workflows/ci.yml')
    run = read(prefix + f'/actions/runs/{run_id}')
    jobs = collection(prefix + f'/actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs', read)
    validate(q, run, jobs, repo, workflow['id'], source, run_id, attempt, tier)
    artifact = request['artifact']; actual = read(prefix + f'/actions/artifacts/{artifact["id"]}')
    need(actual.get('expired') is False and actual.get('name') == f'{tier}-{run_id}-{attempt}'
         and actual.get('digest') == artifact.get('digest') and actual.get('workflow_run', {}).get('id') == run_id
         and actual['workflow_run'].get('head_sha') == source
         and actual['workflow_run'].get('repository_id') == repo['id']
         and actual['workflow_run'].get('head_repository_id') == repo['id'], 'Qualified artifact identity changed or expired')
    if require_current:
        need(read(prefix + '/commits/main').get('sha') == source, 'A newer main commit supersedes this request')
    return {'run': run, 'jobs': {'total_count': len(jobs), 'jobs': jobs}, 'artifact': actual}


def fetch(source, run_id, attempt, tier, read=api):
    need(SHA.fullmatch(source) and type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0
         and tier in {'public-ready', 'release-ready'}, 'Exact workflow inputs required')
    prefix = 'repos/' + REPOSITORY
    artifacts = collection(prefix + f'/actions/runs/{run_id}/artifacts', 'artifacts', read)
    matches = [row for row in artifacts if row.get('name') == f'{tier}-{run_id}-{attempt}' and row.get('expired') is False]
    need(len(matches) == 1, 'Exactly one qualification artifact required')
    artifact = matches[0]; digest = artifact.get('digest', '')
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'Provider artifact digest required')
    archive = read(prefix + f'/actions/artifacts/{artifact["id"]}/zip', binary=True)
    need(len(archive) <= LIMIT and 'sha256:' + hashlib.sha256(archive).hexdigest() == digest, 'Artifact archive digest differs')
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        infos = bundle.infolist()
        need(len(infos) <= 50 and sum(row.file_size for row in infos) <= LIMIT
             and len({row.filename for row in infos}) == len(infos), 'Oversized or ambiguous qualification archive')
        q = json.loads(bundle.read('qualification.json'))
        for ref in [q['provider']['run'], *q['provider']['jobs']]:
            need(re.fullmatch(r'(?:run|jobs-[1-9][0-9]*)\.original\.json', ref['path'])
                 and hashlib.sha256(bundle.read(ref['path'])).hexdigest() == ref['sha256'], 'Original provider snapshot differs')
    need((q.get('source'), q.get('runId'), q.get('runAttempt'), q.get('qualificationTier')) == (source, run_id, attempt, tier), 'Requested qualification differs')
    request = {'version': 1, 'status': 'QUALIFIED_SHELL_DEPLOYMENT_REQUEST', 'repository': REPOSITORY,
               'qualification': q, 'artifact': {'id': artifact['id'], 'name': artifact['name'], 'digest': digest},
               'productionMutation': False, 'privateArtifactsIncluded': False}
    return request, verify(request, read)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True); parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--attempt', type=int, required=True); parser.add_argument('--tier', choices=['public-ready', 'release-ready'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    request, originals = fetch(args.source, args.run_id, args.attempt, args.tier)
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, value in [('request.json', request), ('provider.original.json', originals)]:
        with (args.out / name).open('x') as output:
            json.dump(value, output, sort_keys=True, indent=2); output.write('\n')
    print('Exact main qualification accepted; private publication remains separate.')


if __name__ == '__main__':
    main()
