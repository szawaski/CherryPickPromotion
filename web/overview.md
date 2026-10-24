# Cherry-Pick Promotion

Promote work from one branch to another without merging the whole branch.

1. Open **Repos > Cherry-Pick Promotion** and pick a repository, source branch and target branch.
2. Select **Find changes** to list what's on the source but not the target, grouped by pull request, newest first. **Cancel** at the end of the progress line stops the search. The last search runs again on its own when the page opens.
3. Check what to promote and select **Cherry-pick**.

The selected items are cherry-picked in order onto a new branch, and one pull request is opened into the target, linking their work items. The title follows your selection until you edit it. The description lists the titles of the pull requests and commits it includes.

Enter a **Work item** ID to link it to the pull request as well and put its title in front of the pull request title, e.g. **Release 2.3: Promote 3 PRs 5 commits develop to main**. It's remembered for later promotions until you change or clear it. Check **Auto-complete** to have it complete once policies pass.

## What's listed

- Already promoted items are hidden, including ones squashed into a single commit on the target (matched by file contents).
- Items in an open pull request into the target show **✓ in !N** and can't be selected.
- Open pull requests into the source are shown but can't be selected.
- Merge commits are skipped; their commits are listed instead.
- A selected item that changes a file an unselected earlier item changed first shows **needs !N**; it was written on top of that change and likely conflicts without it. Select the tag to add those items, or **Add N needed items** at the bottom to add everything the selection needs. The same file is enough, even if different lines changed.

## Group by work item

Shows the list as a tree of work items and their parents (task → backlog item → feature). Groups start collapsed.

- An item linked to several work items appears under each; checking it once checks it everywhere.
- A group's checkbox selects everything under it, and the group shows its items' status, e.g. **✓ 2 of 4 in !N**.
- Search matches work item titles and numbers too, so searching for a feature finds everything under it.

## Rebase PR

Cherry-picks don't carry history, so old promoted commits keep being checked. When everything on the source up to a commit is already on the target, select **Create rebase PR into \<target\>**. This opens a pull request that merges the source, as of that commit, into the target. Nothing changes until it's completed.

Complete it with **Merge (no fast-forward)**, not squash. It should change little or nothing, and afterwards the list starts from that point.

## Conflicts

A conflict opens an editor. You can resolve it and continue, **Stop and create PR up to here** (later items stay selected), or **Abort** with no pull request.

Licensed under MIT.
