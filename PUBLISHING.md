# Publishing preparation

Prepare these before the first release:

1. **Package identity:** confirm `@jzhuo3/dynamodb-lib`, ownership of the `@jzhuo3` npm scope, and public visibility (or choose another available name). The directory name does not prove npm ownership.
2. **Rights and metadata:** choose a license and confirm you can redistribute the original service. Add LICENSE, package.json license/author/repository/homepage/bugs metadata, and the Git repository URL. No license or source ownership has been invented here.
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

This repository contains a verification workflow, but no automatic publishing trigger; the actual release identity and credentials still need to be configured.

Official references (checked September 2026):

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm access tokens](https://docs.npmjs.com/about-access-tokens/)
- [AWS SDK runtime support policy](https://github.com/aws/aws-sdk-js-v3/blob/main/README.md)
