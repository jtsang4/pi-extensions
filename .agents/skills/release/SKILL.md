---
name: release
description: 发布本仓库的 @jtsang/pi-extensions npm 包。用户要求发版、发布 npm、打版本标签、release major/minor/patch 或发布指定版本时使用。负责提交本地改动、拉取和合并最新代码、查询 npm 版本、选择并更新版本、推送 Git 标签、跟踪 GitHub Actions Trusted Publishing，并确认 npm 发布结果。未指定版本时先获取最新状态，再让用户选择 major、minor 或 patch。
compatibility: Requires Git, Node.js, the pnpm version pinned in package.json, authenticated GitHub CLI with repository push access, and network access to GitHub and the public npm registry.
---

# Release

从本地工作区完成一次可验证的 npm 发布。此 skill 专用于
`jtsang4/pi-extensions`，发布分支为 `main`，工作流为
`.github/workflows/publish.yml`，版本标签格式为 `v<package.json.version>`。

用户要求发版即授权执行必要的提交、拉取、合并、版本更新和推送。
已指定版本或升级类型时直接执行；只有版本未指定、选择已过时，或无法判断
合并冲突的产品意图时才询问。仅询问发布方法或明确要求预演时，不实际发布。

## 1. 保存本地改动

在仓库根目录读取 `AGENTS.md`、`package.json` 和发布工作流。检查：

```sh
git status --short --branch
git branch --show-current
git remote -v
git diff
git diff --cached
git ls-files --others --exclude-standard
gh repo view --json nameWithOwner,defaultBranchRef
```

确认操作的是上述仓库，使用固定的 pnpm 版本。记录用户给出的 `major`、
`minor`、`patch` 或精确版本（允许输入 `v0.5.0`，存入 package.json 时去掉 `v`）。
检查是否有未完成的 merge/rebase；先理解并处理已有状态，不能丢弃用户的工作。

有改动时，先检查所有待提交文件，包括未跟踪文件，按项目要求执行检查，
至少让 `pnpm check` 和 `git diff --check` 通过，然后 `git add -A`，审阅
`git diff --cached`，使用英文 Conventional Commit 提交。可以按独立主题分成
几个提交，但不要只提交版本文件而漏掉其他代码。工作区干净就跳过此步骤，
不创建空提交，也不以 stash 代替用户要求的提交。

## 2. 拉取并合并最新代码

无论用户是否指定版本，每次发布都同步代码并查询 npm，避免从过时状态发版。
先保存当前分支名和 HEAD，再执行：

```sh
git fetch origin --prune --tags
```

如果当前功能分支在 origin 上有同名分支，先将它合并进当前分支，保留双方提交。
完成这次合并及提交后，重新记录功能分支的 HEAD（不能继续使用合并前的旧 SHA）。
然后切换到本地 `main`（没有时从 `origin/main` 建立跟踪分支），将最新
`origin/main` 合并进来，最后将更新后记录的功能分支 HEAD 合并进 `main`。
当前已经是 `main` 时只需要合并 `origin/main`。用 `git merge --no-commit` 整合；
快进时不会新增提交，分叉时先审阅合并结果并执行项目检查，再创建合并提交。
不用强推、reset --hard 或改写已推送历史来消除分叉。若 `main` 被另一个 worktree
占用，在该 worktree 中按同样流程保护现有改动并整合，不能强行抢占分支。

冲突能根据代码与用户意图确定时直接解决，保留双方有效改动并完成合并提交。
只有存在无法推断的产品取舍才询问具体冲突。依赖冲突先解决 package.json，
再用 pnpm 重新生成锁文件，不手写 pnpm-lock.yaml。合并前检查项目要求；
需要人工完成的合并提交同样使用英文 Conventional Commit。

同步完成后执行 `pnpm install --frozen-lockfile`，重读合并后的版本与工作流。
如果安装失败，先处理实际依赖/锁文件问题，不绕过 frozen 检查继续发布。

## 3. 查询并确定版本

```sh
pnpm view @jtsang/pi-extensions dist-tags versions --json --registry=https://registry.npmjs.org
git tag --list 'v*'
git log --oneline -10
```

记录 npm 的 `latest`、所有已发布版本、同步后的 package.json 版本和待发布改动。
查询失败时重试或处理网络/权限错误，不能把失败当成“尚未发布”。比较版本时
使用 SemVer 的数值顺序，不能按字符串排序；注意 `latest` 可能落后于最高稳定版本。

- **精确版本**：使用用户指定的版本，若 package.json 已是该版本，不再次递增。
  例如 npm 为 `0.4.1`、本地为 `0.5.0`，用户要求发布 `0.5.0`，就发布 `0.5.0`。
- **major/minor/patch**：以“npm 最高已发布稳定版本”和“同步后的本地稳定版本”
  中较高者为基准递增。`A.B.C` 对应 `A+1.0.0`、`A.B+1.0`、`A.B.C+1`。
  如果本地已提前升版，要简短说明基准和目标，不能隐含使用旧 npm 基准。
- **没有指定**：先完成前面的提交、同步和查询，再展示当前 npm/local 版本与三个
  带具体版本号的选项：`major → …`、`minor → …`、`patch → …`，请用户选择。
  可以根据变更推荐一个，但不能自行选择，也不能在回复前修改版本或推送发布标签。
  例：基准 `0.5.0` 的选项为 major `1.0.0`、minor `0.6.0`、patch `0.5.1`。

默认处理稳定版本。若本地或用户指定的是预发布版本，按完整 SemVer 解析，明确
其与稳定基准的关系；不能直接删掉预发布后缀推断一次新的版本升级。
稳定发布的目标不能低于同步后的稳定本地版本，且必须高于 npm 已发布的最高稳定
版本。已有版本转入第 6 节核验结果，不能重复发布、覆盖或降级 `latest`。

若用户选的是已展示的具体版本，等待期间状态变动使它不再可发布，则刷新三个
候选版本重新确认；若用户授权的是升级类型，就按新基准重新计算该类型并告知。
记录本次升级前基准、目标版本，以及当时的远端提交和 npm 版本，供推送前复查。

## 4. 更新版本并验证

只在目标与 package.json 不同时，执行（`release_version` 为已确定的目标）：

```sh
pnpm version "$release_version" --no-git-tag-version
```

此命令不能自动提交或打标签。检查它修改的文件，保持 packageManager 固定，
不创建 npm/Yarn 锁文件，不手工修改 pnpm-lock.yaml。

执行 `pnpm verify`（测试、TypeScript、打包检查）和 `git diff --check`。
涉及扩展行为变化时，再按项目要求加载完整本地包 `pi -e .` 验证。
修复失败后重跑受影响检查；验证通过后，将版本和必要修复提交为
`chore(release): prepare <version>`，或者将有独立含义的修复单独提交。
如果版本早已提交且没有新的修改，跳过提交。

确认工作区干净，待发布提交包含所有用户改动、最新远端代码和发布工作流。
任何检查失败都不能创建发布标签。

## 5. 推送 main 和唯一的发布标签

推送前再次 fetch 并查询 npm。若 origin/main 前进，先合并、重读版本并重新验证；
若外部版本变化使目标不再适用，回到第 3 节。本次自己写入的版本不算外部基准
变化，不能对它再次递增；只合入新代码而版本未变时也保留已确定的目标。
确认后记录发布 HEAD：

```sh
git push --no-follow-tags origin HEAD:refs/heads/main
```

若因远端前进被拒绝，重新同步、验证和推送，不强推。确认远端 main 包含发布
HEAD，package.json 等于目标版本，然后检查本地和远端是否已有 `v<version>`。
比较标签时用 `git rev-parse 'v<version>^{commit}'` 解析注解标签的真实提交。

- 不存在：创建注解标签并只推送这个标签。
- 标签已存在且指向本次发布 HEAD：复用，不重复创建；如果仅本地存在则推送它。
- 标签指向不同提交：保留原标签，核实是已有发布/失败重试还是版本冲突，
  不能移动、删除或强推该标签。要发布新的代码就重新确定新版本。

```sh
git tag -a "v$release_version" -m "Release $release_version"
git push origin "refs/tags/v$release_version:refs/tags/v$release_version"
```

推送标签触发 GitHub-hosted Actions，工作流用 OIDC 发布。
不要在本地执行实际 `pnpm publish`，不要改成使用长期 npm token。
稳定版本走 `latest`，预发布走 `next`。只创建本地标签不会触发发布。

## 6. 跟踪发布并核验 npm

查找本次标签推送触发的工作流：

```sh
gh run list --repo jtsang4/pi-extensions --workflow publish.yml --event push --commit "$release_sha" --limit 20 --json databaseId,headSha,headBranch,status,conclusion,url
gh run watch "$run_id" --repo jtsang4/pi-extensions --exit-status
```

把 `$release_sha` 替换为已记录的发布 HEAD；从列表选择 headSha 和标签均匹配
本次发布的运行，记录 run ID 和 URL。队列暂时未出现时短暂等待重查；监控命令
超时不代表工作流失败，应继续跟踪同一个 run ID，不能因此再次触发发布。

成功后读取日志，确认真正发布而非 dry-run，再查询：

```sh
pnpm view "@jtsang/pi-extensions@$release_version" version gitHead dist.tarball dist.integrity dist.attestations --json --registry=https://registry.npmjs.org
pnpm view @jtsang/pi-extensions dist-tags --json --registry=https://registry.npmjs.org
```

确认精确版本存在、目标 dist-tag 正确，并核对 registry 的 gitHead（若提供）
与发布 HEAD；否则用 provenance 的源提交核对。若更高版本并发发布，不将
`latest` 调回旧版本。registry 传播有延迟时有界重试；仍无法读取就报告待确认，
不能只凭 tag 推送成功宣称 npm 已发布。

失败时读取 `gh run view "$run_id" --log-failed`，同时查精确 npm 版本，确认是否
实际上已发布。对于相同提交的暂时性失败且版本仍不存在，可用 `gh run rerun`
重跑该运行，或在**原标签**手动运行 `publish.yml` 并设置 `dry_run=false`。
需要修改代码时，提交并推送修复，用新版本/新标签重试；不挪动已推送的旧标签。
已发布版本必须核对来源后才视为恢复成功，不能仅凭版本号相同就宣布本次代码已发布。

完成时简要报告 npm 版本、Git 标签和提交、Actions 链接、npm 包链接，以及本地
是否干净且提交已推送。如遇阻塞，说明具体卡在哪一步和已完成的状态。
