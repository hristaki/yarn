/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import type {FetchedMetadata} from './types.js';
import type PackageResolver from './PackageResolver.js';
import type {Reporter} from './reporters/index.js';
import type PackageReference from './PackageReference.js';
import type Config from './config.js';
import * as fetchers from './fetchers/index.js';
import * as fs from './util/fs.js';
import * as promise from './util/promise.js';

const invariant = require('invariant');

export default class PackageFetcher {
  constructor(config: Config, resolver: PackageResolver) {
    this.reporter = config.reporter;
    this.resolver = resolver;
    this.config = config;
  }

  resolver: PackageResolver;
  reporter: Reporter;
  config: Config;

  async fetch(ref: PackageReference): Promise<FetchedMetadata> {
    const dest = this.config.generateHardModulePath(ref);

    if (await this.config.isValidModuleDest(dest)) {
      let {hash, package: pkg} = await this.config.readPackageMetadata(dest);
      return {
        package: pkg,
        resolved: null,
        hash,
        dest,
      };
    }

    // remove as the module may be invalid
    await fs.unlink(dest);

    const remote = ref.remote;
    invariant(remote, 'Missing remote');

    const Fetcher = fetchers[remote.type];
    if (!Fetcher) {
      throw new Error(`Unknown fetcher for ${remote.type}`);
    }

    await fs.mkdirp(dest);

    try {
      const fetcher = new Fetcher(dest, remote, this.config);
      return await fetcher.fetch();
    } catch (err) {
      try {
        await fs.unlink(dest);
      } catch (err2) {
        // what do?
      }
      throw err;
    }
  }

  async maybeFetch(ref: PackageReference): Promise<?FetchedMetadata> {
    let promise = this.fetch(ref);

    if (ref.optional) {
      // swallow the error
      promise = promise.catch((err) => {
        this.reporter.error(err.message);
      });
    }

    return promise;
  }

  async init(): Promise<void> {
    const pkgs = this.resolver.getPackageReferences();
    const tick = this.reporter.progress(pkgs.length);

    await promise.queue(pkgs, async (ref) => {
      const res = await this.maybeFetch(ref);

      if (res) {
        // update with new remote
        ref.remote.hash = res.hash;
        if (res.resolved) {
          ref.remote.resolved = res.resolved;
        }

        // update with fresh manifest
        await this.resolver.updateManifest(ref, res.package);

        if (tick) {
          tick(ref.name);
        }
      }
    });
  }
}