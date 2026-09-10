# Publishing preparation

Prepare these before the first release:

1. **Package identity:** confirm `@jzhuo3/dynamodb-lib`, ownership of the `@jzhuo3` npm scope, and public visibility (or choose another available name). The directory name does not prove npm ownership.
2. **License and metadata:** the library uses the [MIT License](LICENSE), with copyright attributed to `jzhuo3` for 2026. The package license and author metadata are configured. Add repository/homepage/bugs metadata and the Git repository URL before publishing. Preserve the licenses and notices of bundled dependencies.
3. **npm account:** a verified account with publishing rights and configured 2FA. For an initial manual release, run `npm login` locally and `npm whoami`; complete npm's authentication prompts yourself. You do not need to paste a token into chat.
4. **Automated releases:** prefer npm trusted publishing (OIDC) from a supported CI provider. Configure the repository and exact workflow identity in the package's npm settings. This avoids a long-lived NPM_TOKEN. Provision/publish the initial package as required before enabling the trusted publisher for it. Use a supported Node/npm version in the release job.
5. **Token alternative:** when trusted publishing is unavailable, create a scoped, short-lived granular token with package write permission and the authentication settings required by npm's current publishing policy. Store it in the CI secret `NPM_TOKEN` or your local credential configuration. Do not commit `.npmrc` containing a token. Classic tokens should not be used.
6. **Release details:** confirm initial version, README/API behavior, changelog, and the intended npm dist-tag. The current version is `0.1.0` and public access is configured.

A token is not needed to build, test against DynamoDB Local, or produce a tarball. AWS credentials are only needed for the optional real AWS integration suite.

## Release checks

Use Node 22.12+ and npm 11. The initial environment's npm 10 encountered a peer-resolution bug with the patched test toolchain.

```sh
npm ci
npm run check
npm run test:coverage
npm run test:integration
npm run test:install
npm audit
npm pack --dry-run
npm pack
```

Review the generated archive, confirm name/license/repository metadata, and then publish when the release is authorized:

```sh
npm publish --access public
```

`prepublishOnly` runs the source, unit, build and package checks. Integration tests are explicit because they require an available database; CI runs them against DynamoDB Local. The AWS SDK dependency tree is deliberately bundled with the archive, alongside `npm-shrinkwrap.json`, to preserve the tested Node 18-compatible, patched dependencies. After updating dependencies, refresh the shrinkwrap and run the clean consumer installation check as well as the Node runtime matrix.

## Automated publishing

Commit and push the workflows and both Release Please configuration files before creating the next release. `release-please.yml` uses the repository variable `RELEASE_APP_CLIENT_ID` and secret `RELEASE_APP_PRIVATE_KEY` to prepare release PRs and create GitHub releases after those PRs are merged.

When a non-prerelease GitHub release is published, `.github/workflows/publish.yml` checks that its tag is `vX.Y.Z` and matches `package.json`. It runs the reusable CI workflow against that exact commit, including unit, package, coverage, clean installation, and DynamoDB Local integration checks across Node 18, 20, 22, and 24. Only after verification passes does its `publish` job enter the `npm` environment and publish using Node 24 and npm 11. Draft releases and prereleases do not publish to npm.

Configure the npm package's GitHub Actions trusted publisher with owner `maczhuo`, repository `dynamodb-lib`, workflow filename `publish.yml`, environment `npm`, and permission for direct `npm publish`. The GitHub environment `npm` must allow release tags such as `v*`. No `NPM_TOKEN` is required. Any environment approval rules will pause the publish job until satisfied.

The workflow does not retroactively publish existing GitHub releases. If a run fails before publication, fix the external configuration and rerun the failed jobs from GitHub Actions. An already published npm version cannot be published again; code or workflow fixes require a new release containing those changes. Initial package creation may still require the manual bootstrap described above.

Official references (checked September 2026):

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm access tokens](https://docs.npmjs.com/about-access-tokens/)
- [AWS SDK runtime support policy](https://github.com/aws/aws-sdk-js-v3/blob/main/README.md)
