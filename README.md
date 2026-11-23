# Cherry-Pick Promotion

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Promote work from a source branch to a target branch in Azure DevOps by cherry-picking it into one pull request.

1. Pick a repository, source and target branch, then **Find changes**. Source-only commits are listed by pull request, newest first.
2. Check what to promote and select **Cherry-pick**. Items are cherry-picked in landing order onto `cherry-pick/<target>/<timestamp>-<n>`, and one pull request is opened with their work items linked. The title defaults to `[<target>] #<work item> <title>` for one item and `[<target>] #<id> #<id> …` for several.

User-facing behavior is in [web/overview.md](web/overview.md). Implementation notes:

- **Already promoted** means the commit is on the target, in a completed PR into it, or matches a cherry-pick from an earlier promotion by author, author date and first message line. Then `matchContentOnTarget` checks file contents: a commit counts if the target's blob for every file it changed is the one it left, a later source version, or the source head's (deletes match when the file is gone). Lookups that fail leave the commit listed. It costs one changes call per remaining commit and two item lookups per file.
- **Dependencies**: `findDependencies` runs at the end of `matchContentOnTarget` with no extra calls. For each file a commit to promote changes, the earlier commits to promote in its history that changed that file, back to the version the target has, are dependencies (a failed lookup counts). It works by file, not line, so it can warn about edits that wouldn't conflict.
- **Pull request details**: the description is `promotionDescription`, one line per included item starting with its id (`!<PR>` or a direct commit's short id) and then its title. Azure DevOps allows 4,000 characters, so past that the titles are dropped and only the ids are listed; if even those don't fit, `fitLines` replaces the last lines with a count. The **Work item** field is saved per project, added to `workItemIds`, and when set, `defaultTitle` uses it as `[<target>] #<id> <title>`. After the pull request is created, `linkToRelease` (`workItems.ts`) gives each included work item's nearest non-Task ancestor a `System.LinkTypes.Related` link to it and adds the title of its own nearest non-Task ancestor to `System.Tags`, skipping ones already there. Failures only show in the status line, since the pull request stands.
- **Auto-complete** sets `autoCompleteSetBy` to the PR's creator with `deleteSourceBranch`. If that fails, the PR is kept and the status says why.
- **Conflicts**: the editor pushes the resolved commit with its original author, date and message. **Abort** throws `PromotionAborted`, and the branches made so far are deleted.
- **Group by work item** loads work items and their `System.Parent` chain through `wit/workitemsbatch` on first use. Work items that are deleted or unreadable show as "not found or no access".
- **Rebase PR**: a pull request, not a direct rebase. `findSyncPoint` walks the source's first-parent line and stops at the newest commit whose source-only ancestors (except merges) are all on the target; commits only in an open PR don't count. The PR comes from `cherry-pick/<target>/sync/<timestamp>`, a branch at the sync point plus one pushed commit setting every file both sides changed since their merge base (`diffs/commits` with `diffCommonCommit=false`) to the target's version. The pushes API rejects `parents`, so this stands in for git's "ours" merge: merging it can't conflict and leaves the target's files exactly as they are, with `mergeStrategy: noFastForward`, and these PRs are left out when reading earlier promotions.
- Settings (repository, branches, grouping, auto-complete) are kept in local storage per project.

## Layout

| Folder | What it is |
| --- | --- |
| `web` | `CherryPickPromotion.Web.esproj`. Building it runs `npm install` and `npm run build`. |
| `web/src/core` | Azure DevOps REST calls, the promotion logic (`promotion.ts`) and work item grouping (`workItems.ts`). The only copy of the logic. |
| `web/src/ui` | React UI shared by both hosts. |
| `web/src/hosts/extension.tsx` | Azure DevOps extension entry. Calls run as the signed-in user. |
| `web/src/hosts/standalone.tsx` | Entry for the WinForms app. |
| `WinForms` | Test app. Takes an organization URL, project and PAT, and hosts the standalone UI in WebView2. |

The WinForms app serves the UI at `https://cherrypick.local/` and forwards `https://cherrypick.local/ado/...` to the organization, adding the PAT itself, so the page never sees it. With **Remember token** checked, the PAT is saved to the project's user secrets (`%APPDATA%\Microsoft\UserSecrets\<id>\secrets.json`, key `AzureDevOps:Pat`) and the app connects on startup. That file is plain text in your profile, outside the repository. You can also set it with `dotnet user-secrets set AzureDevOps:Pat <token>` from the `WinForms` folder.

## Build and test

```
cd web
npm install
npm test
npm run typecheck
```

Building `CherryPickPromotion.slnx` builds the web project first, and the WinForms app copies its standalone UI. The WinForms app needs the WebView2 runtime, which ships with Windows 11.

The PAT needs **Code (Read, write, & manage)** and **Work Items (Read & write)**. Azure DevOps's cherry-pick API requires the manage level; Read & write gets a 401.

## Publish the extension

1. Set `publisher` in `web/vss-extension.json` to your Marketplace publisher ID.
2. `cd web` then `npm run package`. The `.vsix` is written to `web/out`.
3. Upload it at https://marketplace.visualstudio.com/manage, share it with your organization and install it. It shows up under **Repos > Cherry-Pick Promotion**.

Bump `version` in `vss-extension.json` for each upload. The manifest is private (`"public": false`); add an icon before making it public.

## License

[MIT](LICENSE)
