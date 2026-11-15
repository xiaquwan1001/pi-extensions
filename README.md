# pi-extensions

自用 [pi](https://github.com/earendil-works/pi) 扩展合集：模型速度探针与自动换档、sudo 体验补丁、
fabric 稳定性补丁、Firefox 浏览器说明注入。全部在真实排障中磨出来的，注释里保留了事故背景。

> 这些扩展假设你在用本机 litellm 网关（`127.0.0.1:4000`）＋ `~/.pi/agent/extensions/` 目录加载扩展。
> 路径按需自行改；不写死任何密钥（探针从 `~/litellm/master.key` 读）。

## 目录

| 路径 | 作用 |
|---|---|
| `model-speed.ts` | 会话启动提示过慢档位；会话内实测 TTFT/TPOT，连续 3 轮偏慢就在池内自动换到更快的型号；命令 `/speed`、`/speed-stats` |
| `model-speed/probe.sh` + `_probe_one.py` | 池内各型号 TTFT 探针：**每个型号独立子进程独立超时**，测完一个立刻落盘（慢的不会拖死快的） |
| `model-speed/pi-model-speed-probe.{service,timer}` | systemd --user 定时器，每小时刷新 `last-probe.json` |
| `sudo/sudo-ttl.ts` | `/sudo-ttl [1h\|2h30m\|session\|default]`：查看/修改 `sudo_exec` 凭据缓存有效期（上游 `/sudo` 只有状态与 forget，此插件仍需要） |

> 原先的 `sudo-skip-confirm-patch.ts` / `sudo-credential-verify-patch.ts` 已删除：`@pi-archimedes/sudo` 2.14.0 起原生提供 `archimedes.sudo.confirmWhenCached=false` 与命令失败后的密码探测（对应上游 PR #162、#158）。
| `fabric/exit-diagnostics-patch.ts` | 让被信号杀死的子代理留下真实死因，而不是一句 `exit code null` |
| `fabric/fabric-atomic-write-hardening.ts` | pi-fabric 状态落盘失败（如 `EDQUOT`）降级为警告，不再 uncaughtException 带走主进程 |
| `fabric/fabric-recovery-watchdog-patch.ts` | 放宽 pi-fabric 恢复看门狗硬编码 60s，慢网关下不再误杀仍在重试的子代理 |
| `firefox-browser-prompt/index.ts` | 向主会话注入「本机只有 Firefox（WebDriver BiDi）」的使用说明，取代已移除的 Chromium playbook |

## 安装

```bash
cp model-speed.ts ~/.pi/agent/extensions/
mkdir -p ~/.pi/agent/extensions/model-speed
cp model-speed/{probe.sh,_probe_one.py} ~/.pi/agent/extensions/model-speed/

cp sudo/*.ts fabric/*.ts ~/.pi/agent/extensions/
cp -r firefox-browser-prompt ~/.pi/agent/extensions/
```

`sudo-*` 与 `fabric/*` 是**幂等补丁型**扩展：每次 pi 启动时检查目标包里是否已打补丁，未打则打、文本变了则跳过。
它们改的是 `node_modules` 里的第三方包，`pi install` 升级后会自动重打。

启用每小时探针：

```bash
cp model-speed/pi-model-speed-probe.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-model-speed-probe.timer
```

跑一次完整探针（2k + 150k 上下文，约 1 分钟）：

```bash
bash ~/.pi/agent/extensions/model-speed/probe.sh --sizes "2000 150000" --budget 150
```

## model-speed 是怎么判「慢」的

- 计时锚点用 `before_provider_request` → 首个内容增量，而不是 `message_start`（后者在响应头到达后才触发，算出来恒为 ~0）。
- 上下文规模取 `usage.totalTokens - usage.output`；网关的 `usage.input` 只含**未命中缓存**部分，直接用会严重低估。
- 真实上游型号从响应头 `x-litellm-model-name` 取（模型 id 只是别名）。
- 判慢阈值：`< 30k` 上下文 TTFT > 12s、`≥ 30k` TTFT > 25s、或 TPOT > 250ms/token；连续 3 轮才动，换档后冷却 10 分钟。
  可用环境变量覆盖：`PI_MODEL_SPEED_SLOW_MS`、`PI_MODEL_SPEED_SLOW_LARGE_MS`、`PI_MODEL_SPEED_SLOW_TPOT_MS`、`PI_MODEL_SPEED_WINDOW`。
- 换档只在同一 provider 内、且只切到探针里**更快**的型号；`state.json` 做跨进程锁（pi 可能同时加载两份扩展实例）。

## 配套：模型池分层

探针默认探测池里所有 model id。池本身（litellm 的 `pool-policy.json` / `gen-config.py`）不在本仓库，
但设计是两层：物理型号组（`ustc-dsf` / `ustc-dsf2` / `ustc-glm` / `ustc-qwen`，各自 ×4 key 独立 `model_group`，
便于按型号统计）＋ 语义别名 `ustc`（order 后备链）。按型号分组后，探针与日志才能直接给出「哪个型号慢」。

## 背景：为什么需要这些

一次真实事故：老会话回复经常卡在思考位置。查网关日志发现一天内 168 次
`SocketTimeoutError: Timeout on reading data from socket`，全部落在 20–30 万 token 的上下文上；
同刻直连对比，`deepseek-flash` 在 400k 上下文 TTFT 仍 4.2s，而 `deepseek-flash-2`（w8a8 档）直接 200s 零首字节。
平台状态页自报「不拥塞」是真的——问题是大上下文下的档位退化，不是网络。于是有了这套「探针 + 会话内自动换档」。

其余补丁各自的事故写在文件头注释里。

## License

MIT
