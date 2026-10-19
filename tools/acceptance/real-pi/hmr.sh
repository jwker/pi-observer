#!/bin/zsh
# 档 B：`next dev` 下 HMR 重编译后，globalThis 上的库连接是否还在、数据是否连续
#（技术选型 §14 开工首日检查 4）。
#
# 判据：HMR 前后两次写入都成功，日志里没有 database is locked / SQLITE_BUSY。
#
# ⚠️ 有两个真实副作用：
#   1. 会杀掉 4173 上的监听进程，并改用 `next dev` 起在同一端口；
#   2. 会临时往 src/app/page.tsx 末尾追加一行再恢复（跑完恢复）。
#
# 前置：仓库已 build 过（dev 模式不需要产物，但首次编译会慢）。
# 用法：zsh tools/acceptance/real-pi/hmr.sh
set -u

HERE=${0:A:h}
REPO=${HERE:h:h:h}
OUT=${TMPDIR:-/tmp}/pi-observer-accept-real/hmr
PORT=4173
BASE=http://127.0.0.1:$PORT

rm -rf $OUT && mkdir -p $OUT
cd $REPO
TOKEN=$(tr -d '\n' < data/token)
RUN=$(date +%s)   # 每次跑用不同的事件 id：老 id 会被幂等忽略，看落库结果会看到上一轮的旧行

echo "=== 停掉 4173 上的生产服务 ==="
lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill -9 2>/dev/null
sleep 1

echo "=== 起 next dev ==="
nohup npx next dev -H 127.0.0.1 -p $PORT > $OUT/dev.log 2>&1 &
for i in $(seq 1 40); do
  curl -s -m 1 $BASE/api/health > /dev/null 2>&1 && break
  sleep 1
done
curl -s $BASE/api/health; echo

send () {
  curl -s -o /dev/null -w "POST $1 → HTTP %{http_code}\n" -X POST \
    -H "content-type: application/json" -H "x-observer-token: $TOKEN" \
    -d "{\"protocol\":1,\"probe_version\":\"0.1.0\",\"dropped_count\":0,\"queue_depth\":0,\"records\":[{\"kind\":\"event\",\"event_id\":\"$1\",\"session_id\":\"hmr-test\",\"layer\":\"turn\",\"event_type\":\"turn_start\",\"payload\":{\"n\":1},\"occurred_at\":null,\"run_seq\":1,\"turn_index\":0}]}" \
    $BASE/api/ingest
}

echo "=== 第一次写入 ==="
send "hmr-$RUN-a"

echo "=== 触发 HMR：改 page.tsx ==="
cp src/app/page.tsx $OUT/page.tsx.bak
printf '\n// 触发 HMR 重编译（验收临时改动）\n' >> src/app/page.tsx
sleep 6
curl -s -o /dev/null -w "GET / → HTTP %{http_code}\n" $BASE/

echo "=== HMR 之后第二次写入 ==="
send "hmr-$RUN-b"

echo "=== 恢复 page.tsx ==="
cp $OUT/page.tsx.bak src/app/page.tsx
sleep 3

echo "=== 落库结果（两条都该在，说明连接没丢）==="
sqlite3 data/observer.db "SELECT event_id, received_at FROM events WHERE session_id='hmr-test' ORDER BY id;"
COUNT=$(sqlite3 data/observer.db "SELECT count(*) FROM events WHERE session_id='hmr-test' AND event_id LIKE 'hmr-$RUN-%';")
echo "本轮落库事件数：$COUNT（应为 2）"

echo "=== dev 日志里是否有锁/错误 ==="
grep -iE "database is locked|SQLITE_BUSY|Error:|⨯" $OUT/dev.log | head -10
echo "（以上为空则无锁错误）"
echo "=== 日志尾部 ==="
tail -6 $OUT/dev.log

echo "=== 清理：删掉 hmr-test 的测试数据 ==="
sqlite3 data/observer.db "DELETE FROM events WHERE session_id='hmr-test'; DELETE FROM sessions WHERE session_id='hmr-test';"
sqlite3 data/observer.db "SELECT count(*) AS 剩余hmr行 FROM events WHERE session_id='hmr-test';"

if [ "$COUNT" != "2" ]; then
  echo "✘ 本轮事件没有全部落库：期望 2，实际 $COUNT"
  exit 1
fi

echo "=== 产物 ==="
echo "日志目录：$OUT"
echo "提醒：现在 4173 上跑的是 next dev，要换回生产服务请手动重启 npm run start。"
