# Cherry-Pick Promotion

Promote work from one branch to another without merging the whole branch.

1. Open **Repos > Cherry-Pick Promotion** and pick a repository, a source branch and a target branch.
2. Select **Find changes**. You get the commits on the source branch that are not on the target, grouped by the pull request that brought them in, newest first. Commits without a pull request are listed on their own.
3. Check the pull requests and commits to promote and select **Cherry-pick**.

The extension cherry-picks the selected items in the order they landed, onto a new branch, and opens one pull request into the target branch. The pull request links every work item from the selected pull requests and commits.

Items already on the target are hidden. Items in an open pull request into the target, and open pull requests into the source, are shown but can't be selected. Merge commits are skipped; their changes come from the commits they merged.

If a commit conflicts, a conflict editor opens so you can resolve it and carry on. Or skip it: the pull request then gets every selected item that landed before the conflicting one, and that item and the ones after it stay selected for later.

Licensed under MIT.
