#!/usr/bin/env bash
#
# Hypnoy — one-shot deploy.
# Run this locally (or hand it to Claude Code) where your `gh` and `vercel`
# CLIs are already logged in. It will:
#   1. (re)initialize git and commit
#   2. create a private GitHub repo "Hypnoy" and push
#   3. create/link a Vercel project, set ANTHROPIC_API_KEY, and deploy to prod
#
# Nothing here stores your secrets: the API key is read with a hidden prompt
# and piped straight to `vercel env add`.
#
# WARNING: step 1 runs `rm -rf .git && git init`, which wipes the current
# repo's git history and creates a brand-new repo. Run this only on a
# standalone/extracted copy of the app — NOT inside an existing repo you
# want to keep.

set -euo pipefail

REPO_NAME="Hypnoy"
cd "$(dirname "$0")"

say()  { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git    >/dev/null || die "git not found."
command -v gh     >/dev/null || die "GitHub CLI (gh) not found — install it or create the repo manually, then re-run."
command -v vercel >/dev/null || die "Vercel CLI not found — run: npm i -g vercel"

gh auth status   >/dev/null 2>&1 || die "Not logged in to GitHub — run: gh auth login"

# ---------------------------------------------------------------- 1. git
say "Preparing git repository"
rm -rf .git                       # clear any partial/locked .git from earlier
git init -q
git branch -M main
git add -A
if git diff --cached --quiet; then
  die "Nothing to commit — are you in the Hypnoy folder?"
fi
git commit -q -m "Hypnoy: standalone AI hypnosis generator (Vite + React + Vercel function)"

# ---------------------------------------------------------------- 2. GitHub
if gh repo view "$REPO_NAME" >/dev/null 2>&1; then
  say "GitHub repo $REPO_NAME already exists — pushing"
  OWNER="$(gh api user --jq .login)"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${OWNER}/${REPO_NAME}.git"
  git push -u origin main --force
else
  say "Creating private GitHub repo $REPO_NAME and pushing"
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
fi

# ---------------------------------------------------------------- 3. Vercel
say "Linking Vercel project (creates it if new)"
vercel link --yes --project "$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]')" >/dev/null

say "Setting ANTHROPIC_API_KEY"
printf 'Paste your Anthropic API key (sk-ant-...), input hidden: '
read -rs ANTHROPIC_API_KEY
echo
[ -n "$ANTHROPIC_API_KEY" ] || die "No key entered."

# Remove any existing value first so re-runs don't error, then add to both envs.
for ENV in production preview; do
  vercel env rm ANTHROPIC_API_KEY "$ENV" --yes >/dev/null 2>&1 || true
  printf '%s' "$ANTHROPIC_API_KEY" | vercel env add ANTHROPIC_API_KEY "$ENV" >/dev/null
done
unset ANTHROPIC_API_KEY

say "Deploying to production"
PROD_URL="$(vercel deploy --prod --yes)"

say "Deployed: ${PROD_URL}"
echo
echo "Verify:"
echo "  open  ${PROD_URL}/hypnosis"
echo "  curl -sS -X POST \"${PROD_URL}/api/hypnosis\" -H 'Content-Type: application/json' \\"
echo "       -d '{\"prompt\":\"calm focus before a meeting\",\"durationMinutes\":5,\"tone\":\"warm\"}' | head -c 400"
