#!/bin/sh
# The editor coding agents open with ctrl-g ($VISUAL), for Herdr.app: hands the
# agent's prompt file to the prompt editor docked under the agent's pane and waits.
#
#   export VISUAL="sh $HOME/.config/herdr-app/mods/prompt-editor/editor.sh"
#   export PROMPT_EDITOR_FALLBACK=nvim   # everything else: git commit, outside Herdr
#
# It takes over only when it runs in a Herdr.app terminal and was started by a
# coding agent (PROMPT_EDITOR_AGENTS): docked under the pane when the layout
# shows the prompt editor there, else as a dialog. Otherwise the file goes to
# PROMPT_EDITOR_FALLBACK untouched; with no fallback set it exits 3, so a wrapper of
# its own can pick another editor.
#
#   PROMPT_EDITOR_AGENTS   process names counted as agents
#                     (default: claude codex pi opencode gemini)
#   PROMPT_EDITOR_FORCE=1  skip that check (a wrapper that only agents call)
#   PROMPT_EDITOR_DEBUG=1  log hand-offs to data/prompt-editor/debug.log

file=$1

fallback() {
  if [ -n "${PROMPT_EDITOR_FALLBACK:-}" ]; then
    exec $PROMPT_EDITOR_FALLBACK "$@"
  fi
  exit 3
}

# Which agent started us? One of the nearest ancestors, by name: `comm` is the
# binary (claude, codex); node agents like pi show as node, so argv too.
agent=
find_agent() {
  names=" ${PROMPT_EDITOR_AGENTS:-claude codex pi opencode gemini} "
  pid=$PPID
  for _ in 1 2 3 4; do
    [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null || return 1
    for word in $(ps -o comm= -p "$pid" 2>/dev/null) $(ps -o args= -p "$pid" 2>/dev/null | cut -d' ' -f1-2); do
      case $names in *" ${word##*/} "*) agent=${word##*/}; return 0 ;; esac
    done
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

[ -n "${HC_TERMINAL_ID:-}" ] && [ -n "$file" ] || fallback "$@"
find_agent || [ "${PROMPT_EDITOR_FORCE:-}" = 1 ] || fallback "$@"

app=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
cli=$(command -v herdr-app 2>/dev/null || echo "$HOME/.local/bin/herdr-app")
[ -x "$cli" ] || fallback "$@"

spool="$app/data/prompt-editor"
req="$spool/$HC_TERMINAL_ID.req"
done="$spool/$HC_TERMINAL_ID.done"
mkdir -p "$spool"
rm -f "$done"
case $file in /*) ;; *) file=$PWD/$file ;; esac
printf '%s\n' "$file" > "$req"

# Docked: every prompt editor shown gets "open" and the one under this terminal
# takes it. None shown (a layout without it): the command is unknown, so open
# one as a dialog for this terminal instead.
out=$("$cli" do prompt-editor.open 2>&1)
status=$?
how=docked
if [ "$status" -ne 0 ]; then
  how=dialog
  printf '%s\n' "$HC_TERMINAL_ID" > "$spool/pending"
  out=$("$cli" do mod.open '{"name":"prompt-editor"}' 2>&1)
  status=$?
fi
[ -n "${PROMPT_EDITOR_DEBUG:-}" ] && printf '%s term=%s agent=%s file=%s %s=%s %s\n' "$(date +%T)" \
  "$HC_TERMINAL_ID" "$agent" "$file" "$how" "$status" "$out" >> "$spool/debug.log"
if [ "$status" -ne 0 ]; then
  rm -f "$req" "$spool/pending"
  fallback "$@"
fi

# --- While the prompt editor is open: the agent has handed this terminal over, so
# draw a card saying where the prompt went, on a screen of our own (the agent's
# comes back as it was).

case $agent in
  claude) name="Claude Code" ;;
  codex) name="Codex" ;;
  pi) name="pi" ;;
  opencode) name="OpenCode" ;;
  gemini) name="Gemini CLI" ;;
  *) name="the agent" ;;
esac

esc=$(printf '\033')
dim="$esc[2m" bold="$esc[1m" accent="$esc[35m" off="$esc[0m"
key() { printf '%s[7m %s %s[27m' "$esc" "$1" "$esc"; }
at() { printf '%s[%d;%dH' "$esc" "$1" "$2"; }

size() {
  s=$( { stty size </dev/tty; } 2>/dev/null) || s="24 80"
  rows=${s% *} cols=${s#* }
}

draw() {
  size
  drawn="$rows $cols"
  printf '%s[2J' "$esc"
  if [ "$cols" -lt 52 ] || [ "$rows" -lt 14 ]; then
    at 2 3; printf '%s✎%s %sWriting for %s%s' "$accent" "$off" "$bold" "$name" "$off"
    at 4 3; printf '%s send  %s new line  %s back' "$(key '↩')" "$(key '⇧↩')" "$(key esc)"
    status_row=6 status_col=3
    return
  fi
  w=64
  [ "$cols" -lt 68 ] && w=$((cols - 4))
  # Off-centre upwards: a prompt editor docked at the bottom covers the lower part.
  top=$(((rows - 22) / 2))
  [ "$top" -lt 1 ] && top=1
  left=$(((cols - w) / 2 + 1))
  hr=
  i=2
  while [ "$i" -lt "$w" ]; do hr="$hr─"; i=$((i + 1)); done
  at "$top" "$left"; printf '%s╭%s╮' "$dim" "$hr"
  r=1
  while [ "$r" -lt 10 ]; do
    at $((top + r)) "$left"; printf '│'
    at $((top + r)) $((left + w - 1)); printf '│'
    r=$((r + 1))
  done
  at $((top + 10)) "$left"; printf '╰%s╯%s' "$hr" "$off"
  c=$((left + 4))
  at $((top + 2)) "$c"; printf '%s✎%s  %sWriting a prompt for %s%s' "$accent" "$off" "$bold" "$name" "$off"
  at $((top + 4)) "$c"; printf '%sThe prompt editor is open on this pane, with all%s' "$dim" "$off"
  at $((top + 5)) "$c"; printf '%syou had typed. Finish the prompt there.%s' "$dim" "$off"
  at $((top + 7)) "$c"; printf '%s send   %s new line   %s back to %s' "$(key '↩')" "$(key '⇧↩')" "$(key esc)" "$name"
  status_row=$((top + 9)) status_col=$c
}

restore() { printf '%s[2J%s[?25h%s[?1049l' "$esc" "$esc" "$esc"; }
printf '%s[?1049h%s[?25l' "$esc" "$esc"
draw

# Up to an hour; Ctrl-C in the agent gives up.
trap 'restore; rm -f "$req" "$done"; exit 1' INT TERM HUP
frames="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
i=0
while [ ! -f "$done" ] && [ $i -lt 36000 ]; do
  # Every second: did the pane change size?
  if [ $((i % 10)) -eq 0 ]; then
    size
    [ "$rows $cols" = "$drawn" ] || draw
  fi
  set -- $frames
  shift $((i % 10))
  at "$status_row" "$status_col"; printf '%s%s%s %swaiting for you in the prompt editor%s' "$accent" "$1" "$off" "$dim" "$off"
  sleep 0.1
  i=$((i + 1))
done
answer=$(cat "$done" 2>/dev/null)
restore
rm -f "$req" "$done" "$spool/pending"

# Submit: the agent reads the file back once we exit, then gets Enter.
if [ "$answer" = submit ]; then
  hc=$(command -v hc 2>/dev/null || echo "$HOME/.local/bin/hc")
  (sleep 0.3; "$hc" keys "$HC_TERMINAL_ID" enter) >/dev/null 2>&1 &
fi
