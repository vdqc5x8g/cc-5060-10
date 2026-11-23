# 频带补全实验台（Band-Completion Bench）

交互式频谱编辑窗口：在频谱图上框选一段**明确标记的缺损时频区域**，内核依据局部谐波 / 连续性先验估计缺口内容，并在**固定观测区**的约束下重建波形。输出候选频谱与候选音频，冲突时给出多个互斥候选与置信边界，补全后反投影审计原区。

> 关键立场：缺口内的样本是**算法估计**，不是“恢复出来的原始事实”。观测区（掩码外）在重建中被硬性固定。界面和报告里所有措辞都遵守这一点。

## 怎样启动界面

```bash
npm install          # 只有 Playwright 测试需要依赖；运行界面本身无需额外依赖
npm start            # 等价于 node server.js，默认端口 4173
```

然后浏览器打开 **http://localhost:4173/** 。换端口用 `PORT=5000 npm start`。

界面启动后默认载入第一个合成素材，直接在频谱图上拖拽即可框选，点击“补全所选区域”运行内核。顶部状态点与状态文字反映内核状态（就绪 / 运行中 / 完成 / 拒绝 / 审计未通过）。撤销按钮保留上一次状态。

## 界面里怎么用

1. **选素材或上传 WAV**：下拉框是内置合成素材（含已知真值，用于自检）；也可载入自己的 WAV。
2. **框选缺损区**：在频谱画布上按住拖拽，松开即生成 `时间 × 频率` 选区（横轴时间、纵轴频率，左侧刻度为 Hz，画布下方显示秒 / Hz）。
3. **调模型条件**：FFT、Hop、最大缺口长度（ms）、最大带宽（Hz）、已知区容差（dB）。这些参数直接传入内核，超出上限会被**拒绝**而非填充。
4. **补全**：结果区显示状态徽章、候选列表（每个候选有频谱缩略图与描述）、假设说明、置信边界、一致性审计；冲突时列出左右候选与混合候选，置信度标低。
5. **对照音频**：原缺损录音与补全结果并排，可“从选区播放”做 A/B，可下载结果 WAV。
6. **撤销**：恢复到上一次状态（包括最初的原始素材）。
7. **合成真值自检**：点击“运行全部素材自检”，逐条对完整合成音频人为抹去频带后补全，用**留出真值**检查补全误差、已知区变化、整体伪影。

## 真值隔离

- `src/kernel/complete.js` 只接收**缺损录音 + 掩码**，从不导入评估模块。
- `src/eval/evaluate.js` 是唯一接触合成真值的模块，只在补全完成之后运行。
- 服务端仅在识别到内置素材（或调用方显式另行上传一条与录音等长的真值轨）时调用评估；该真值从未进入内核输入。

## 命令行自检

```bash
npm run bench        # 对全部素材跑补全 + 留出真值评估，打印矩阵；有已知区违约或预期不符则退出码非 0
npm test             # 单元测试：FFT/STFT、WAV 编解码、内核拒答/冲突/审计、评估器
```

`npm run bench` 输出示例（列含义：improvement 是频带受限的缺口段 SNR 提升，corr 是相位敏感相关，copy 是“复制邻近频带”这一被禁止基线的提升——应始终低于本算法）：

```
fixture          expect     status   match chosen     conf   improve_dB corr  copy_dB known_dB known_ok outside_smpl
harmonic-short   supported  ok       yes   harmonic   medium 8.19       0.973 -3.37   —        ident    0
harmonic-long    refused    refused  yes   —          —      —          —     —        —        ident    —
pad-noise        supported  ok       yes   harmonic   high   0.58       0.763 -2.95   —        ident    0
conflict-or-not  conflict   ok       yes   blend      low    0.91       0.780 -0.83   —        ident    0
wide-gap         refused    refused  yes   —          —      —          —     —        —        ident    —
clean-mid        supported  ok       yes   harmonic   high   11.97      0.988 -2.68   —        ident    0
```

## 浏览器端到端测试（可选）

UI 用 Playwright + Firefox 验证四条流程：框选 → 补全 → 切换候选 → 撤销；超宽区域被拒绝；相斥素材给出全部候选与低置信；自检矩阵逐条产出 6 行。首次需要安装浏览器：

```bash
npx playwright install firefox
npx playwright test
```

（在无 root 的容器中，可能需要把 Firefox 依赖的共享库放到 `LD_LIBRARY_PATH` 后再运行；这是运行环境问题，不是应用依赖。）

## 目录结构

```
server.js                  HTTP 服务：素材 / 频谱 / 补全 / 评估 API + 静态资源
public/                    纯浏览器前端（无框架）：index.html、app.js、styles.css
src/kernel/                fft.js、stft.js、analyze.js、complete.js、wav.js
src/eval/evaluate.js       唯一接触真值的评估模块
src/fixtures/generate.js   确定性合成素材（真值 / 缺损 / 声明区域）
bench/run-bench.js         命令行真值矩阵
test/                      单元测试 + e2e/ui.test.mjs、e2e/flows.test.mjs
```

## 模型支持范围（会明确拒绝，而不是硬填）

| 条件 | 默认上限 | 超出时行为 |
| --- | --- | --- |
| 缺口时长 | 200 ms | 拒绝并给出原因 |
| 缺口带宽 | 1500 Hz | 拒绝并给出原因 |
| 单侧观测帧数 | 4 帧 | 拒绝并给出原因 |

拒绝时返回原始录音不变，不复制邻近频带。探测到左右证据互斥（相关低 / 幅度差大）时，输出 `blend / left / right` 三个候选、标低置信度，并在报告中说明“缺口内段不应视为唯一事实”。
