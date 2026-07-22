# Git Governance

This repository follows the AGEN-17 Git push runbook plus the current branch
cleanup policy.

## Remote Branch Policy

- `main` and `master` are the only long-lived remote branches.
- Task, review, and agent branches are local working branches unless a task gives
  explicit authorization to publish a named remote branch.
- Do not create or push temporary remote branches for routine multi-worker
  collaboration.
- Do not delete remote branches, force push, or rewrite remote history unless a
  task explicitly authorizes that exact action.

## Integration Flow

1. Start from the task's stated baseline branch or commit.
2. Make only the files or artifacts authorized by the task.
3. Commit locally with a message that names the task when a commit is required.
4. Report the local branch name and commit SHA for review.
5. The principal maintainer integrates accepted work into `main` and pushes the
   final shared state.
6. Review results or follow-up fixes are reported from `master` when applicable,
   or by creating/updating the relevant task.

## AGEN-17 Push Preconditions

Before any push, confirm and report:

- `git remote -v` shows the expected `origin` fetch and push URLs.
- `git status --short --branch` shows the current branch and pending changes.
- `git ls-remote --heads origin` shows the current remote branch set.
- The task explicitly states the allowed push target.

If the allowed target is unclear, stop before pushing and report the local branch
and commit SHA instead.

## Review Evidence

Each Git-related result report must include:

- task ID
- actual scope of work
- changed files or artifacts
- branch name
- commit SHA
- push summary or a clear statement that no push was authorized
- validation commands, exit codes, and key output
- residual risks and next step
