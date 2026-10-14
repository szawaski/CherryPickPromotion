# Cherry-Pick Promotion

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Promote work from a source branch to a target branch in Azure DevOps by cherry-picking it into one pull request.

1. Pick a repository, a source branch and a target branch, then **Find changes**.
2. The tool lists the commits on the source that are not on the target, grouped by pull request, newest first. Commits without a pull request are listed on their own.
3. Check what to promote and select **Cherry-pick**. The selected items are cherry-picked in the order they landed, onto a new `cherry-pick/<target>/<timestamp>-<n>` branch, and one pull request is opened into the target. It links every work item from the selected pull requests and commits.

Already promoted items are hidden: their commits are on the target, in a completed pull request into the target, or cherry-picked by an earlier promotion (matched by author, author date and first line of the message). Items in an open pull request into the target are shown with **✓ in !N** and can't be selected. Open pull requests into the source are shown but can't be selected. Merge commits are skipped; their changes come from the commits they merged.

If a commit conflicts, the conflict editor opens. It shows the target's and the incoming version side by side above an editable result, one conflict at a time. **Commit and continue** pushes the resolved commit (keeping its author, date and message) and the cherry-pick carries on. **Skip this item** stops there: the pull request gets every selected item that landed before it, and that item and the ones after it stay selected.

## Layout

| Folder | What it is |
| --- | --- |
| `web` | `CherryPickPromotion.Web.esproj`. Building it runs `npm install` and `npm run build`. |
| `web/src/core` | Azure DevOps REST calls and the promotion logic. The only copy of the logic. |
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
