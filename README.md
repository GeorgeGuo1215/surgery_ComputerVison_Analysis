# 视频指定区域数字识别与时间戳 CSV 导出

本项目用于从视频的固定位置周期性截取画面，通过 PaddleOCR 识别其中的数字，并生成带有绝对时间戳的 CSV 文件。当前脚本针对监护仪左下角的**心率数字**做了规则优化，适合将视频中的实测心率与模型预测结果按时间戳对齐、比较和绘图。

主程序：[readnumberpa.py](readnumberpa.py)

## 1. 程序做了什么

程序的处理顺序如下：

1. 从视频文件名中寻找最后一个 6 位数字，并将其解释为视频结束时间 `HHMMSS`。
2. 读取视频时长，用“结束时间 - 视频时长”计算视频开始时间。
3. 让用户选择自动计算的开始时间，或手动输入绝对开始时间。
4. 按用户指定的间隔（例如每 `0.2` 秒）读取一帧。
5. 截取每帧左下角的固定区域（ROI，Region of Interest）。
6. 使用 PaddleOCR 识别 ROI 内的文字，提取并修正常见的数字误识别。
7. 按心率范围和相邻采样值过滤明显异常结果。
8. 为每个采样点计算绝对时间，保存为 CSV；识别失败时另存 ROI 图片，方便排查。

> **北京时间说明：** 脚本不会查询系统时区，也不会自动进行 UTC 与北京时间之间的转换。CSV 中的时间是否为北京时间，完全取决于 `date_str`、文件名中的结束时刻或手动输入的开始时刻是否采用北京时间。请确保这些输入统一为北京时间（UTC+8）。

## 2. 环境要求

建议使用：

- Windows 10/11（其他系统也可运行，但命令略有不同）
- Python 3.9～3.11
- 能被 OpenCV 正常解码的视频文件
- 首次运行 PaddleOCR 时可能需要联网下载识别模型

### 2.1 创建虚拟环境

在 PowerShell 中进入项目目录：

```powershell
cd D:\Projects\surgery_ComputerVison_Analysis
py -m venv .venv
.\.venv\Scripts\Activate.ps1
```

如果 PowerShell 阻止激活脚本，可仅对当前窗口调整策略：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\.venv\Scripts\Activate.ps1
```

Linux/macOS：

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 2.2 安装依赖

```powershell
python -m pip install --upgrade pip
python -m pip install paddlepaddle paddleocr opencv-python numpy pandas
```

如果使用 NVIDIA GPU，请根据 PaddlePaddle 官方文档选择与 CUDA 版本匹配的 GPU 安装包，不要同时安装互相冲突的 CPU/GPU 包。

验证主要依赖：

```powershell
python -c "import cv2, numpy, pandas, paddleocr; print('dependencies OK')"
```

## 3. 准备视频和时间信息

### 3.1 视频文件名规则

默认视频路径在 `main()` 中配置：

```python
video_path = "8.8_164149.MOV"
```

脚本会提取文件名中**最后一组 6 位连续数字**作为视频结束时刻：

| 文件名 | 解析出的结束时刻 |
|---|---|
| `8.8_164149.MOV` | `16:41:49` |
| `operation_20260808_093015.mp4` | `09:30:15` |

6 位数字必须是有效的 `HHMMSS`。例如，`246099` 不是有效时间。文件名中的日期不会被程序自动采用；日期由代码中的 `date_str` 决定。

### 3.2 设置日期

在 `main()` 中将日期改成视频结束时刻对应的北京时间日期：

```python
date_str = "2026-08-01"
```

程序先构造：

```text
视频结束时间 = date_str + 文件名中的 HHMMSS
视频开始时间 = 视频结束时间 - 视频时长
```

例如，视频名为 `case_164149.MOV`、`date_str` 为 `2026-08-01`、视频时长为 60 秒，则自动计算的时间范围约为：

```text
开始：2026-08-01 16:40:49（北京时间）
结束：2026-08-01 16:41:49（北京时间）
```

如果录像跨越零点，`date_str` 仍应填写**结束时刻所在日期**，程序会通过减去时长自动得到前一天的开始日期。

### 3.3 自动时间与手动时间

运行后程序提供两种选择：

- 输入 `1`：采用由文件名和视频时长推算的开始时间。
- 输入 `2`：手动输入采样起点，格式必须为 `YYYY-MM-DD HH:MM:SS`。

手动时间的含义是“视频第 0 秒对应的绝对时间”。如果格式错误，脚本会退回自动计算值。

## 4. 识别视频特定位置的数字

### 4.1 ROI 的含义

ROI 是每一帧中真正送入 OCR 的矩形区域。区域越贴近目标数字、背景越少，识别通常越稳定，速度也越快。

当前调用为：

```python
roi_ratio=(0.4, 0.1)
```

`extract_roi()` 固定从画面**左下角**截取：

- `0.4`：ROI 宽度为整帧宽度的 40%。
- `0.1`：ROI 高度为整帧高度的 10%。

示意图：

```text
视频画面
┌────────────────────────────────────┐
│                                    │
│                                    │
│                                    │
├──────────────┐                     │
│ 左下角 ROI   │                     │
└──────────────┴─────────────────────┘
  宽 = 40%        高 = 10%
```

若数字仍位于左下角，只需修改这两个比例。例如：

```python
roi_ratio=(0.25, 0.18)  # 左侧 25% 宽、底部 18% 高
```

建议从较大的区域开始，查看异常帧图片后逐步缩小，直到 ROI 只包含目标数字及少量边缘背景。

### 4.2 目标不在左下角时

当前 `extract_roi()` 只支持以左下角为锚点。如果目标位于其他位置，可将它改为按四个比例坐标裁剪：

```python
def extract_roi(frame, roi_box=(0.0, 0.9, 0.4, 1.0)):
    """roi_box = (x1, y1, x2, y2)，均为相对整帧的 0～1 比例。"""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = roi_box
    return frame[
        int(h * y1):int(h * y2),
        int(w * x1):int(w * x2),
    ]
```

坐标原点位于左上角，`x` 向右增大，`y` 向下增大：

```text
(0,0) ───────────────→ x
  │
  │      (x1,y1) ┌────────┐
  │              │  ROI   │
  │              └────────┘ (x2,y2)
  ↓ y
```

几个例子：

| 位置 | `roi_box` 示例 |
|---|---|
| 左上角 30% × 20% | `(0.0, 0.0, 0.3, 0.2)` |
| 右上角 30% × 20% | `(0.7, 0.0, 1.0, 0.2)` |
| 左下角 40% × 10% | `(0.0, 0.9, 0.4, 1.0)` |
| 画面中央 | `(0.35, 0.35, 0.65, 0.65)` |

采用这种写法后，还需将 `sample_video_and_ocr()` 的参数名及调用处从 `roi_ratio` 相应改为 `roi_box`。比例坐标比固定像素更适合分辨率不同但布局相同的视频。

### 4.3 如何精确确定 ROI

推荐按以下方法调试：

1. 选取一帧清晰、数字完整的画面。
2. 先使用较大的 ROI，运行一次程序。
3. 打开 `error_frames` 中的 `*_0_raw_roi.png`，确认目标数字是否完整位于图片中。
4. 调整宽度、高度或四个边界比例，避免切掉数字笔画。
5. 尽量排除其他文字、单位、图标和相邻数值。
6. 用亮、暗、模糊和数字变化明显的多个时刻复测，而不是只看一帧。

若完全没有异常帧，也可以临时在读取 `roi` 后加入以下代码保存一个样例，再在确认 ROI 后删除：

```python
if i == 0:
    cv2.imwrite("roi_preview.png", roi)
```

### 4.4 数字识别与过滤规则

当前代码并不是通用的任意数字识别器，而是针对心率做了以下处理：

- OCR 置信度阈值为 `0.2`。
- 将 `o/q/l/i/|/s/z/t` 等易混淆字符修正为相似数字。
- 删除所有非数字字符。
- 优先取连续 3 位数字，再尝试连续 2 位数字。
- 只接受 `30～250` 的值。
- 对部分漏识别情况进行补齐，例如 `11 → 111`、`15 → 115`。
- 与上一个有效值相差超过 `100` 时，认为是极端跳变，并沿用上一个值。
- 当前帧识别失败且已有历史有效值时，也沿用上一个有效值。

如果目标不是心率，应同步修改：

- `ocr_digits()` 中允许的位数和数值范围；
- `complete_partial_heart_rate()` 中的心率专用补齐规则；
- `JUMP_THRESHOLD` 跳变阈值；
- CSV 字段名或输出文件后缀（如有需要）。

## 5. 设置采样间隔并运行

运行：

```powershell
python .\readnumberpa.py
```

按提示选择开始时间后，输入采样间隔（秒）：

```text
0.2
```

这表示每 0.2 秒识别一次，即理论上每秒 5 个采样点。直接回车时默认使用 0.2 秒。

常用间隔：

| 间隔 | 理论采样率 | 适用情况 |
|---:|---:|---|
| `1.0` 秒 | 1 次/秒 | 数值变化较慢、希望减少处理时间 |
| `0.5` 秒 | 2 次/秒 | 一般时间对齐 |
| `0.2` 秒 | 5 次/秒 | 当前默认值，兼顾时间精度与速度 |
| `0.1` 秒 | 10 次/秒 | 需要更细时间分辨率，处理量较大 |

计划采样点数约为：

```text
floor(视频时长 / 采样间隔) + 1
```

采样间隔必须大于 0。它不应小于一帧的时长（约为 `1 / FPS`），否则多个采样时刻可能实际落在同一帧上，而且不会增加真实时间分辨率。

## 6. 输出文件

假设输入文件为：

```text
8.8_164149.MOV
```

正常结果会保存为：

```text
8.8_164149_hr_data_full.csv
```

异常图片默认保存在：

```text
error_frames/
```

每个异常采样点通常有两张图：

- `*_0_raw_roi.png`：未经处理的彩色 ROI，适合检查裁剪位置和原始画面。
- `*_1_preprocessed.png`：灰度二值化结果，辅助判断亮度、对比度和笔画问题。当前 OCR 实际读取的是原始 ROI，二值图仅用于排错。

## 7. CSV 字段说明

CSV 包含以下字段：

| 字段 | 含义 | 示例 |
|---|---|---|
| `timestamp` | 采样点的绝对时间，精确到毫秒；输入时间为北京时间时，此列即北京时间 | `2026-08-01 16:40:49.200` |
| `video_time_s` | 采样点距视频开头的秒数 | `0.2` |
| `raw_value` | PaddleOCR 返回并拼接后的原始文本；可能为空或包含误识别字符 | `l18` |
| `filtered_value` | 经过字符修正、范围检查、补齐和连续性过滤后的最终数值 | `118` |

分析时通常使用 `timestamp` 和 `filtered_value`。`raw_value` 用于审核识别质量，`video_time_s` 用于回到原视频定位问题。

注意：`filtered_value` 可能是沿用上一采样点的值，并不保证每一行都来自该帧的成功识别；需要严格区分“真实识别值”和“填充值”时，应扩展程序增加识别状态列。

## 8. 用 CSV 与预测结果按时间戳对齐

### 8.1 对预测 CSV 的要求

以下示例假设预测文件 `predictions.csv` 至少包含：

```csv
timestamp,predicted_value
2026-08-01 16:40:49.100,116.8
2026-08-01 16:40:49.300,117.4
```

请确保：

- 两份数据采用同一时区，推荐都使用北京时间。
- 两份时间戳代表同一事件定义，例如都是采样发生时刻，而不是一个为采样时刻、另一个为结果写入时刻。
- 时间列均可解析，并先按时间升序排列。
- 两台设备若存在固定时钟偏差，应先校正该偏差。

### 8.2 最近时间点匹配

当预测时间与识别时间不完全相同，可用 pandas 的 `merge_asof` 匹配最近时间点：

```python
import pandas as pd

observed = pd.read_csv("8.8_164149_hr_data_full.csv")
predicted = pd.read_csv("predictions.csv")

observed["timestamp"] = pd.to_datetime(observed["timestamp"])
predicted["timestamp"] = pd.to_datetime(predicted["timestamp"])
observed["filtered_value"] = pd.to_numeric(
    observed["filtered_value"], errors="coerce"
)

observed = observed.sort_values("timestamp")
predicted = predicted.sort_values("timestamp")

aligned = pd.merge_asof(
    predicted,
    observed[["timestamp", "filtered_value", "video_time_s"]],
    on="timestamp",
    direction="nearest",
    tolerance=pd.Timedelta("300ms"),
)

aligned["error"] = aligned["predicted_value"] - aligned["filtered_value"]
aligned["absolute_error"] = aligned["error"].abs()
aligned.to_csv("aligned_comparison.csv", index=False, encoding="utf-8-sig")
```

这里的 `tolerance="300ms"` 表示只接受相差不超过 300 毫秒的匹配。建议容差略大于采样间隔的一半，并结合两套系统的时钟误差调整。容差过大可能错误匹配，过小则会产生较多空值。

### 8.3 统一到固定时间网格

若两份数据采样频率不同，也可先将时间设为索引，再重采样。例如统一到 1 秒：

```python
observed_1s = (
    observed.set_index("timestamp")["filtered_value"]
    .resample("1s")
    .mean()
)
```

连续心率数据可根据分析目的使用均值、中位数或最近值。不要在未说明的情况下将缺失值大量前向填充，因为这可能掩盖 OCR 失败或录像中断。

### 8.4 计算基础误差指标

```python
valid = aligned.dropna(subset=["predicted_value", "filtered_value"])

mae = valid["absolute_error"].mean()
rmse = (valid["error"].pow(2).mean()) ** 0.5
bias = valid["error"].mean()

print(f"匹配点数: {len(valid)}")
print(f"MAE: {mae:.3f}")
print(f"RMSE: {rmse:.3f}")
print(f"Bias: {bias:.3f}")
```

建议同时报告匹配成功率、时间容差、采样间隔和被人工排除的异常区间，避免只看误差指标。

## 9. 质量检查建议

正式使用 CSV 前，建议完成以下检查：

1. 核对首行和末行 `timestamp` 是否与视频实际开始、结束时刻一致。
2. 随机选取若干 `video_time_s`，跳转到视频对应位置，人工核对画面数字。
3. 重点检查 `error_frames` 中的图片和数值突变区间。
4. 检查 `raw_value` 为空但 `filtered_value` 非空的记录；这些通常是沿用历史值。
5. 绘制 `filtered_value` 随时间变化的曲线，查找不自然的平台或跳变。
6. 如果与预测值始终存在相似的时间偏移，优先排查设备时钟、视频结束时间定义和推理延迟。

本工具的 OCR 和过滤结果不应直接作为医疗诊断依据。用于科研或评估时，建议保留原视频、参数、异常帧和人工复核记录，确保结果可追溯。

## 10. 常见问题

### 找不到 6 位时间字段

原因：视频文件名中没有连续 6 位数字。将文件重命名为包含结束时刻的形式，例如：

```text
case_164149.MOV
```

### 无法打开视频

检查 `video_path` 是否正确、扩展名是否匹配，以及 OpenCV 是否支持该视频编码。必要时可先用 FFmpeg 转为常见的 H.264 MP4。

### OCR 总是为空或错误

- 检查 ROI 是否包含完整数字。
- 缩小 ROI，排除其他文字和图标。
- 检查视频是否模糊、反光、过暗或数字太小。
- 查看异常帧，而不是只看最终 CSV。
- 必要时调整图像缩放、对比度或二值化，并用多段视频验证。
- 如果识别的不是心率，移除或修改 `30～250` 的范围约束。

### 最终数值长时间不变

可能是 OCR 连续失败后一直沿用 `last_valid_hr`，也可能是 `JUMP_THRESHOLD=100` 拒绝了真实变化。对照 `raw_value`、异常帧和原视频检查。

### Excel 打开中文正常，但数字或时间格式不符合预期

程序使用 `utf-8-sig`，一般可被中文版 Excel 正确识别。为避免 Excel 自动改写毫秒时间，建议使用“数据 → 从文本/CSV”导入，并明确指定时间列格式；科研分析优先使用 pandas 直接读取。

### 采样点没有覆盖视频最后一帧

程序按 `0, t, 2t, ...` 采样。若视频时长不是间隔的整数倍，最后一个采样点会早于视频实际末尾；这是正常现象。

## 11. 运行前注意事项

- 当前项目需手动安装百度PaddleOCR。
- 修改 `video_path`、`date_str` 和 ROI 后再运行。


## 12. 最小使用清单

1. 安装 Python、PaddlePaddle、PaddleOCR、OpenCV、NumPy 和 pandas。
2. 将视频放入项目目录，并确保文件名末尾附近含有效的 6 位结束时间 `HHMMSS`。
3. 修改 `readnumberpa.py` 中的 `video_path` 和 `date_str`。
4. 修改 `roi_ratio`，确保左下角 ROI 只覆盖目标数字；目标不在左下角时改用四坐标 ROI。
5. 运行 `python .\readnumberpa.py`，选择时间来源并输入采样间隔。
6. 检查生成的 `*_hr_data_full.csv` 和 `error_frames/`。
7. 用 `timestamp` 与预测 CSV 做最近时间点匹配，并对识别结果抽样复核。
