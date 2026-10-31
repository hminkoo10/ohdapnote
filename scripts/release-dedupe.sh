#!/usr/bin/env bash
# 같은 태그에 GitHub 릴리스가 둘 이상 만들어졌을 때 하나로 정리합니다.
# (electron-builder 26.17 이 설치 파일과 blockmap 을 동시에 올리다가 릴리스를 두 개 만드는 문제 대응)
#  - latest.yml 이 있는 릴리스를 남기고
#  - 나머지 릴리스에만 있던 파일(blockmap 등)은 남길 릴리스로 옮긴 뒤 지웁니다. 태그는 그대로 둡니다.
# 필요: gh (GH_TOKEN), GITHUB_REPOSITORY=owner/repo
# DRY_RUN=1 이면 무엇을 할지만 출력
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY 가 필요합니다}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
run() {
  if [ "${DRY_RUN:-}" = "1" ]; then echo "DRY_RUN: $*"; else "$@"; fi
}

gh api "repos/$repo/releases?per_page=100" --paginate \
  --jq '.[] | [(.id|tostring), .tag_name, ([.assets[].name] | join(","))] | @tsv' > "$work/releases.tsv"

dups="$(cut -f2 "$work/releases.tsv" | sort | uniq -d)"
if [ -z "$dups" ]; then
  echo "겹친 릴리스 없음"
  exit 0
fi

for tag in $dups; do
  keep="$(awk -F'\t' -v t="$tag" '$2==t && $3 ~ /(^|,)latest\.yml(,|$)/ {print $1; exit}' "$work/releases.tsv")"
  if [ -z "$keep" ]; then
    echo "::warning::$tag: latest.yml 이 든 릴리스가 없어 그대로 둡니다"
    continue
  fi
  keep_assets="$(awk -F'\t' -v k="$keep" '$1==k {print $3}' "$work/releases.tsv")"
  for id in $(awk -F'\t' -v t="$tag" -v k="$keep" '$2==t && $1!=k {print $1}' "$work/releases.tsv"); do
    echo "$tag: 릴리스 $id 정리 (남길 릴리스 $keep)"
    mkdir -p "$work/$id"
    while IFS=$'\t' read -r aid name; do
      [ -n "$aid" ] || continue
      case ",$keep_assets," in *",$name,"*) echo "  $name: 남길 릴리스에 이미 있음"; continue ;; esac
      echo "  $name 옮기기"
      run gh api -H 'Accept: application/octet-stream' "repos/$repo/releases/assets/$aid" > "$work/$id/$name"
    done < <(gh api "repos/$repo/releases/$id" --jq '.assets[] | [(.id|tostring), .name] | @tsv')
    run gh api -X DELETE "repos/$repo/releases/$id"
    shopt -s nullglob
    moved=("$work/$id"/*)
    shopt -u nullglob
    if [ "${#moved[@]}" -gt 0 ]; then
      run gh release upload "$tag" "${moved[@]}" --clobber --repo "$repo"
    fi
  done
done
