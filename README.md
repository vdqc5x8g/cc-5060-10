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
npm test             # 单元测试：FFT/STFT、WAV 编解码、内核拒答/冲突/审计、评估器、可信区域验证、入库验收数据
npm run trust        # 可信区域验证（干净运行 + 三类受控故障），逐条对照独立推导的期望
```

### 可信区域验证（图形入口为主，命令行为辅）

界面主窗口向下滚动到 **“可信区域验证”** 面板即为图形入口：

1. 在“验证素材”下拉框选择同宽配对（`pairA-harmonic` / `pairA-inharmonic`，缺口几何完全相同、可辨性相反）、宽度扫描或先验不满足素材；
2. 在“受控故障”里选择干净运行，或注入 **污染可信区 / 错误自信标记 / 错误填充缺口**；
3. 点击“运行可信验证”，面板显示裁决（通过/失败）、命名失败码与全部独立证据；“运行全部正反例”一次跑完 22 条记录。

命令行只做辅助：

```bash
npm run trust               # 干净 + 变异套件，期望不符则退出码非 0
npm run trust:write-data    # 重新生成 data/trust-acceptance.json（验收数据入库）
npm run trust:verify-data   # 实时重测并与入库数据逐条比对，漂移即失败（防伪报）
```

验收的期望值**独立推导**：只依据素材声明的可辨性与注入的故障类型，从不读取测量输出；已知区误差、候选分歧、子带守恒、投影下界均由只依赖 STFT 原语的独立参照模块（`src/trust/reference.js`、`src/trust/projection-limit.js`）计算，内核的置信标签只作为不受信任的输入被审查。两类命名失败：

- **错误自信（false-confidence）**：不可辨缺口被当作单一确定答案（候选不充分分歧、缺少低置信标记，或下界证据链被破坏）；
- **污染已知样本（known-pollution）**：观测单元/样本被改动，超出声明容差或窗外样本非零。

另有 `fill-inconsistency`（交付波形与声明候选不符）与 `conservation-breach`（参照子带能量被改动）。故意污染可信区或注入错误自信/错误填充时验收必须失败，且这些反例与干净运行一并入库。

### 独立投影误差下界的适用范围

`src/trust/projection-limit.js` 用两个**相互独立、仅依赖观测区**的投影（时间线性子空间 `V_time`、频率周期子空间 `V_periodic`）估计缺口，由三角不等式得到无真值下界 `max(‖z−z1‖,‖z−z2‖) ≥ ‖z1−z2‖/2`。

- 下界在代数上**始终成立**（测试对每条素材断言不等式不被违反），但只有两个先验产生分歧时才**有信息量**；
- 当两个投影落入同一偏置零空间（共享错误假设）时，分歧趋零，下界仍然有效却是**空洞的**——小分歧绝不等于高确定性。测试用退化网格显式断言这种 `vacuous` 情形；
- 观测拟合残差（线性拟合 dB、周期自相关）用于判断先验是否适用：谐波素材周期度高、线性残差小，非谐素材反之。以可信子带守恒（掩码正交能量拆分，误差 ~1e-16）为参照，界定该下界何时可用于证明不确定性、何时只能保留为无效数字。


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
server.js                  HTTP 服务：素材 / 频谱 / 补全 / 评估 / 可信验证 API + 静态资源
public/                    纯浏览器前端（无框架）：index.html、app.js、styles.css
src/kernel/                fft.js、stft.js、analyze.js、complete.js、wav.js
src/eval/evaluate.js       唯一接触真值的评估模块
src/fixtures/generate.js   确定性合成素材（真值 / 缺损 / 声明区域）
src/trust/                 可信区域验证（不导入内核、不接触缺损前真值）
  fixtures-trust.js        同宽可辨性配对、宽度扫描、先验不满足素材生成器
  reference.js             独立参照：已知区误差、候选分歧、子带守恒、补全一致性
  projection-limit.js      独立投影误差下界及其适用范围（含零空间空洞情形）
  faults.js                受控故障：污染可信区 / 错误自信 / 错误填充
  acceptance.js            验收裁决与命名失败码（阈值与依据在此声明）
  runner.js                编排：内核 → 独立度量 → 投影检验 → 验收
bin/trust-check.js         命令行辅助：跑套件 / 写入并复核 data/ 验收数据
data/trust-acceptance.json 入库的验收数据（22 条，含正反例与变异，可复现）
bench/run-bench.js         命令行真值矩阵
test/                      单元/HTTP 集成测试 + e2e/（含 trust.test.mjs）
```

## 模型支持范围（会明确拒绝，而不是硬填）

| 条件 | 默认上限 | 超出时行为 |
| --- | --- | --- |
| 缺口时长 | 200 ms | 拒绝并给出原因 |
| 缺口带宽 | 1500 Hz | 拒绝并给出原因 |
| 单侧观测帧数 | 4 帧 | 拒绝并给出原因 |

拒绝时返回原始录音不变，不复制邻近频带。探测到左右证据互斥（相关低 / 幅度差大）时，输出 `blend / left / right` 三个候选、标低置信度，并在报告中说明“缺口内段不应视为唯一事实”。
