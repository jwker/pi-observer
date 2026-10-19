#!/bin/zsh
# 档 B：强杀服务端 → 等 30 秒 → 重启（PRD §14 M1 第 3 条）。
#
# 判据：探针不崩溃、Pi 照常答完、恢复后积压继续入库、dropped_count 可查。
#
# ⚠️ 有两个真实副作用：
#   1. 会杀掉 4173 上的**监听**进程（你要是正开着 npm run start，它会被杀）——
#      只杀监听者，不碰探针的客户端连接；
#   2. 会调用真实模型（花 token）。
#
# 前置：4173 上有真实服务端在跑（npm run start）。
# 用法：zsh tools/acceptance/real-pi/downtime.sh
set -u

HERE=${0:A:h}
REPO=${HERE:h:h:h}
OUT=${TMPDIR:-/tmp}/pi-observer-accept-real/downtime
PORT=4173
BASE=http://127.0.0.1:$PORT
DOWN_SECONDS=30

rm -rf $OUT && mkdir -p $OUT
cd $REPO

echo "=== 0. 前置：服务端在跑 ==="
curl -s $BASE/api/health; echo

echo "=== 1. 起一个长会话（探针已加载）==="
nohup pi -p -a --session-dir $OUT/sessions --extension $REPO/ext \
  "用 bash 连续执行三次 sleep 12（每次单独一次工具调用），每次之后用一句话说明第几次完成。" \
  > $OUT/pi.out 2> $OUT/pi.err &
PI_PID=$!
echo "Pi PID=$PI_PID"
sleep 5

echo "=== 2. SIGKILL 服务端（只杀监听者，别误伤探针的客户端连接）==="
lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill -9
KILL_TS=$(node -e 'console.log(new Date().toISOString())')
echo "KILL_TS=$KILL_TS"
sleep 1
curl -s -m 2 $BASE/api/health > /dev/null 2>&1 && echo "服务端仍在响应（异常）" || echo "服务端已不可达（预期）"

echo "=== 3. 等 $DOWN_SECONDS 秒 ==="
sleep $DOWN_SECONDS

echo "=== 4. 探针/Pi 是否还活着 ==="
if ps -p $PI_PID > /dev/null; then echo "Pi 进程存活（探针没把 Pi 拖崩）"; else echo "Pi 进程已退出"; fi
echo "--- 探针 stderr 里 pi-observer 的日志行数 ---"
grep -c "pi-observer" $OUT/pi.err | xargs echo "行数:"
head -5 $OUT/pi.err

echo "=== 5. 重启服务端 ==="
nohup npx next start -H 127.0.0.1 -p $PORT > $OUT/server2.log 2>&1 &
RESTART_TS=$(node -e 'console.log(new Date().toISOString())')
echo "RESTART_TS=$RESTART_TS"
sleep 6
curl -s $BASE/api/health; echo

echo "=== 6. 等 Pi 结束（最多 90 秒）==="
for i in $(seq 1 45); do
  ps -p $PI_PID > /dev/null || break
  sleep 2
done
ps -p $PI_PID > /dev/null && echo "Pi 仍在运行（超时）" || echo "Pi 已结束"
echo "--- Pi 输出 ---"
cat $OUT/pi.out

echo "=== 7. 恢复后等探针把积压发完 ==="
sleep 8

echo "=== 8. 落库结果 ==="
node --input-type=module - "$KILL_TS" "$RESTART_TS" "$BASE" <<'JS'
const [, , killTs, restartTs, base] = process.argv;
const sessions = (await (await fetch(`${base}/api/sessions`)).json()).sessions ?? [];
const target = sessions
  .filter((session) => String(session.cwd).includes("pi-observer"))
  .sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at))[0];
if (!target) {
  console.log("找不到目标会话");
} else {
  const events = (await (await fetch(`${base}/api/sessions/${target.session_id}/events?limit=2000`)).json()).events ?? [];
  const during = events.filter((event) => event.occurred_at && event.occurred_at > killTs && event.occurred_at < restartTs);
  const after = events.filter((event) => event.occurred_at && event.occurred_at >= restartTs);
  const kinds = {};
  for (const event of events) kinds[event.event_type] = (kinds[event.event_type] ?? 0) + 1;
  console.log("会话:", target.session_id, "| 状态:", target.state, "| 来源:", target.source);
  console.log("事件总数:", events.length, "| 停机期间发生:", during.length, "| 恢复后发生:", after.length);
  console.log("事件类型:", JSON.stringify(kinds));
  const health = await (await fetch(`${base}/api/health`)).json();
  console.log("probe_status:", JSON.stringify(health.probe));
  console.log("判据：停机期间发生的事件 > 0 且恢复后已落库，dropped_count 应为 0。");
}
JS

echo "=== 产物 ==="
echo "日志目录：$OUT"
