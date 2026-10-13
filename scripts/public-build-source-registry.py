#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""One source closure for the full-root frontend producer and its admission.

Registry reads local maintained modules only. It neither executes historical
receipt sources nor contacts an instance.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def source_names():
    stage = module('public_build_stage_sources', 'stage-public-delivery.py')
    contract = module('public_build_producer_sources', 'prepare-public-shell.py')
    # Owner validation can follow generation acceptance into the maintained
    # private publication/catalog validator. Include that dynamic branch too.
    return stage.SOURCE_NAMES | contract.PRODUCER_SOURCES | {
        'public-build-source-registry.py', 'verify-public-baseline.py',
        'public-shell-codings.mjs', 'generation-acceptance.py',
        'publish-private-shell.py', 'plan-private-shell.py',
    }


def verify_sources(refs, read_ref):
    names = source_names()
    if type(refs) is not list or len(refs) != len(names):
        raise RuntimeError('Complete original public builder source closure required')
    sources = {}
    for ref in refs:
        read_ref(ref)
        path = Path(ref['path'])
        if (path.name not in names or path.name in sources
                or hashlib.sha256((HERE / path.name).read_bytes()).hexdigest() != ref['sha256']):
            raise RuntimeError('Original builder differs from reviewed maintained helper bytes')
        sources[path.name] = ref
    return sources


if __name__ == '__main__':
    print(json.dumps(sorted(source_names()), separators=(',', ':')))
