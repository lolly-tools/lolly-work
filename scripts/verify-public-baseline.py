#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Read original full-root serving custody; never contact or mutate a target."""
import argparse
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('public_lifecycle', Path(__file__).with_name('public-delivery-lifecycle.py'))
l = importlib.util.module_from_spec(spec); spec.loader.exec_module(l)


def verify(value):
    l.exact(value, {'version', 'acceptedRelease', 'image', 'manifest', 'source', 'publicPin'})
    l.need(value['version'] == 1, 'Closed public baseline request required')
    accepted = l.held(value['acceptedRelease'])
    l.exact(accepted, l.ACCEPTED_KEYS | {'publication'})
    l.need(accepted['version'] == 2 and accepted == l.publication_baseline(accepted['publication']),
        'Only a complete original full-root serving acceptance can seed a build')
    publication = l.held(accepted['publication']['input']); runtime = l.held(publication['stageInput'])
    prepared = l.held(runtime['prepared'])
    l.need(accepted['image'] == value['image'] and prepared['source'] == value['source']
        and accepted['manifestSha256'] == value['manifest']['sha256']
        and l.held(accepted['publicPin']) == l.held(value['publicPin']), 'Requested baseline tuple differs from actual serving custody')
    l.held(value['manifest'])
    return {'version': 1, 'status': 'ORIGINAL_PUBLIC_FULL_ROOT_BASELINE_VERIFIED_READ_ONLY',
        'acceptedRelease': value['acceptedRelease'], 'source': value['source'], 'image': value['image'],
        'manifest': value['manifest'], 'models': accepted['models'], 'publicPin': accepted['publicPin'],
        'productionMutation': False, 'newRuntimeAcceptance': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True); parser.add_argument('--sha256', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = verify(l.held({'path': args.input, 'sha256': args.sha256}))
    output = l.a.write_new(Path(args.output), l.raw(result))
    print(l.raw(output).decode())


if __name__ == '__main__': main()
