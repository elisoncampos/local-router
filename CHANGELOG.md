# @elisoncampos/local-router

## 0.4.3

### Patch Changes

- [`581cb4d`](https://github.com/elisoncampos/local-router/commit/581cb4dadf6139bb30f1be7db1afd4a99da68826) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Fix privileged ports issue when running with --share

## 0.4.2

### Patch Changes

- [`c4a3264`](https://github.com/elisoncampos/local-router/commit/c4a326462d0dbb3aaf6797ee38faee66ad995469) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Fixes localhost.run url in banner

## 0.4.1

### Patch Changes

- [`468b2c2`](https://github.com/elisoncampos/local-router/commit/468b2c2b12025aa6f425edc170edf6c7dd6149a6) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Fix an issue where the url returned from localhost.run was not the properly url to be shared

## 0.4.0

### Minor Changes

- [`6017bbd`](https://github.com/elisoncampos/local-router/commit/6017bbd757bb2025bfbde4e24716f1c050fd99f1) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Added --share support to local-router run using localhost.run, so apps can be exposed through a temporary public HTTPS URL without touching /etc/hosts, while preserving the project's local hostname as the upstream Host header

## 0.3.1

### Patch Changes

- [`5eefe1c`](https://github.com/elisoncampos/local-router/commit/5eefe1c5435b95c04d88469612722500bca30db0) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Fixing an issue with orphaned proxy instances and improving the output of list command

## 0.3.0

### Minor Changes

- [`26b2467`](https://github.com/elisoncampos/local-router/commit/26b2467fe074c11c19475f32759b2f80362f6b48) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Adding a command to show all proxied services, some fixes in cleanup

## 0.2.1

### Patch Changes

- [`0a7afa2`](https://github.com/elisoncampos/local-router/commit/0a7afa2b6b122e918b00104ca2ed0277a6d207a8) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Fix an issue where running the cli on certain circunstances would cause an error

## 0.2.0

### Minor Changes

- [`7a9d77a`](https://github.com/elisoncampos/local-router/commit/7a9d77aa956776e55c7cf3e11361ba4b6bcc780b) Thanks [@elisoncampos](https://github.com/elisoncampos)! - Improved lifecylcle events with cleanup step

All notable changes to this project will be documented in this file.
