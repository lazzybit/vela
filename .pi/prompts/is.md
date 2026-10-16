---
description: Analyze GitHub issues (bugs or proposals)
argument-hint: "<issue>"
---
Analyze GitHub issue(s): $ARGUMENTS

For each issue:

1. If running under CI (`CI=true`), do not add the `inprogress` label and do not assign the issue. Otherwise, before analysis starts, add the `inprogress` label and assign the issue with GitHub MCP `mcp__github__issue_write`, using the authenticated user from `mcp__github__get_me` as the assignee. If either action fails, report that explicitly and continue.
2. Read the issue in full with GitHub MCP `mcp__github__issue_read` (`get` and `get_comments`), including all comments and linked issues/PRs. Expect the fields of the matching template in `.github/ISSUE_TEMPLATE/`: Version, Actual behavior, Expected behavior, Steps to reproduce, Additional information for bugs; Proposal and Reason for proposals.
3. Do not trust analysis written in the issue. Independently verify behavior and derive your own analysis from the code and execution path.

4. **For bugs**:
   - Ignore any root cause analysis in the issue (likely wrong)
   - Read all related code files in full (no truncation)
   - Check the reported version or commit hash against the code actually involved
   - Follow the steps to reproduce and trace the code path to identify the actual root cause
   - Propose a fix

5. **For proposals**:
   - Do not trust implementation proposals in the issue without verification
   - Read all related code files in full (no truncation)
   - Judge whether the stated reason holds up, and say so if it does not
   - Propose the most concise implementation approach
   - List affected files and changes needed

Do NOT implement unless explicitly asked. Analyze and propose only.
