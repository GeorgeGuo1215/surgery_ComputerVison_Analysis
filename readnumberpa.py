import os
import re
import cv2
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from paddleocr import TextRecognition

# 初始化识别模型
print("Initializing OCR model...")
rec_model = TextRecognition()

def parse_end_time_from_filename(filename):
    basename = os.path.basename(filename)
    name, _ = os.path.splitext(basename)
    matches = re.findall(r'(\d{6})', name)
    if not matches:
        raise ValueError(f"文件名中未找到 6 位数字时间字段: {filename}")
    hhmmss = matches[-1]
    hh, mm, ss = int(hhmmss[0:2]), int(hhmmss[2:4]), int(hhmmss[4:6])
    return hh, mm, ss

def build_datetime(date_str, hh, mm, ss):
    dt_str = f"{date_str} {hh:02d}:{mm:02d}:{ss:02d}"
    return datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")

def get_video_info(video_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    if fps <= 0:
        raise RuntimeError("无法获取视频 FPS")
    return frame_count / fps, fps

def extract_roi(frame, roi_ratio=(0.3, 0.3)):
    """截取左下角 ROI；ratio 用你自己调好的即可"""
    h, w = frame.shape[:2]
    rw, rh = roi_ratio
    roi_w, roi_h = int(w * rw), int(h * rh)
    x1, x2 = 0, min(roi_w, w)
    y1, y2 = max(h - roi_h, 0), h
    return frame[y1:y2, x1:x2]

def preprocess_pure_digits(roi):
    """
    仅用于错误帧图像输出的简单预处理，不参与 OCR 逻辑。
    如无特别需求，可以保持为简单灰度 + 二值化。
    """
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
    return thresh

def ocr_digits(roi_image):
    # 转换为 BGR，确保输入格式正确
    if len(roi_image.shape) == 2:
        img = cv2.cvtColor(roi_image, cv2.COLOR_GRAY2BGR)
    else:
        img = roi_image

    try:
        result = rec_model.predict(img)
    except Exception as e:
        print(f"OCR predict error: {e}")
        return None, None, ""

    rec_texts = []
    if result and isinstance(result, list):
        for res in result:
            # 兼容对象属性读取
            if hasattr(res, "rec_text") and hasattr(res, "rec_score"):
                txt, score = res.rec_text, res.rec_score
                if score >= 0.2:
                    rec_texts.append(str(txt))
            # 兼容字典格式读取
            elif isinstance(res, dict) and "rec_text" in res:
                txt, score = res["rec_text"], res["rec_score"]
                if score >= 0.2:
                    rec_texts.append(str(txt))

    if not rec_texts:
        return None, None, ""

    # 合并识别出的文本，转为小写
    text_all = "".join(rec_texts).lower()
    print(f"DEBUG: OCR Raw Text: '{text_all}'")

    # 常见易错字符映射表（将相似字符纠正为数字）
    char_map = {
        '日': '8', 'b': '8',
        'o': '0', 'q': '9',
        'l': '1', 'i': '1', '|': '1',
        's': '5', 'z': '2', 't': '7',
        '一': '1', '二': '2', '三': '3',
        '四': '4', '五': '5'
    }
    corrected_text = ""
    for char in text_all:
        if char in char_map:
            corrected_text += char_map[char]
        else:
            corrected_text += char

    # 过滤掉所有非数字字符
    digits_only = re.sub(r'\D', '', corrected_text)
    print(f"DEBUG: Corrected Digits: '{digits_only}'")

    if not digits_only:
        return text_all, None, digits_only

    # 心率规则约束：优先匹配 3 位数
    m3 = re.search(r'\d{3}', digits_only)
    if m3:
        val = int(m3.group(0))
        if 30 <= val <= 250:
            return text_all, str(val), digits_only

    # 备用匹配 2 位数
    m2 = re.search(r'\d{2}', digits_only)
    if m2:
        val = int(m2.group(0))
        if 30 <= val <= 250:
            return text_all, str(val), digits_only

    return text_all, None, digits_only

def complete_partial_heart_rate(digits_only, last_valid_hr):
    """补齐 OCR 漏掉百位数字 1 的几种已知情况。"""
    fixed_two_digit_values = {
        "11": 111,
        "15": 115,
        "17": 117,
        "18": 118,
    }
    if digits_only in fixed_two_digit_values:
        return str(fixed_two_digit_values[digits_only])

    # 上一帧已经处于 110~119 时，允许根据末位补齐 111/117/118。
    if last_valid_hr is not None and 110 <= last_valid_hr <= 119:
        fixed_one_digit_values = {
            "1": 111,
            "7": 117,
            "8": 118,
        }
        if digits_only in fixed_one_digit_values:
            return str(fixed_one_digit_values[digits_only])

    return None

def sample_video_and_ocr(video_path, T_start, duration, t,
                         roi_ratio=(0.35, 0.35),
                         error_dir="error_frames"):
    """
    正式版采样：
    - 全程按 t 采样，不再限制前 5 帧
    - 保存 CSV 所需字段
    - 识别异常时输出错误图像（原始 ROI + 预处理图）
    """
    if not os.path.exists(error_dir):
        os.makedirs(error_dir)

    cap = cv2.VideoCapture(video_path)
    results = []
    num_samples = int(duration // t) + 1

    print(f"[开始采样] 计划采样点数: {num_samples}, 间隔: {t}s")
    print(f"[提示] 识别异常的帧将保存至: {os.path.abspath(error_dir)}")

    last_valid_hr = None

    for i in range(num_samples):
        t_video = i * t
        if i % 100 == 0:
            print(f"[进度] {i}/{num_samples} ({i/num_samples*100:.1f}%), 时间: {t_video:.2f}s")

        cap.set(cv2.CAP_PROP_POS_MSEC, t_video * 1000.0)
        ret, frame = cap.read()
        if not ret:
            print("Failed to read frame, stop.")
            break

        roi = extract_roi(frame, roi_ratio)
        raw_value, value, digits_only = ocr_digits(roi)
        if value is None:
            value = complete_partial_heart_rate(digits_only, last_valid_hr)

        # 异常判定：识别失败或心率不在合理范围
        is_error = False
        if value is None:
            is_error = True
        else:
            try:
                val_int = int(value)
                if val_int < 30 or val_int > 250:
                    is_error = True
            except:
                is_error = True

        # 错误帧输出：原始 ROI + 简单预处理图
        if is_error:
            prefix = os.path.join(error_dir, f"err_frame_{i}_t{t_video:.2f}_val{value}")
            cv2.imwrite(f"{prefix}_0_raw_roi.png", roi)
            pre_img = preprocess_pure_digits(roi)
            cv2.imwrite(f"{prefix}_1_preprocessed.png", pre_img)

        # 心率连续性过滤逻辑：只过滤极端跳变，允许正常升降
        filtered_value = value
        if value:
            curr_val = int(value)

            if last_valid_hr is None:
                # 第一个有效值，直接接受
                last_valid_hr = curr_val
                filtered_value = str(curr_val)
            else:
                # 与上一帧心率的绝对差值
                diff = abs(curr_val - last_valid_hr)

                # 阈值：超过 100 bpm 的跳变认为是异常（可根据数据调整）
                JUMP_THRESHOLD = 100

                if diff > JUMP_THRESHOLD:
                    # 极端跳变，怀疑 OCR 出错，用上一帧值
                    filtered_value = str(last_valid_hr)
                else:
                    # 正常变化（升或降），接受
                    last_valid_hr = curr_val
                    filtered_value = str(curr_val)

        elif last_valid_hr is not None:
            # 当前帧识别失败，用上一帧心率填充
            filtered_value = str(last_valid_hr)

        T_real = T_start + timedelta(seconds=t_video)
        results.append({
            'timestamp': T_real.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            'video_time_s': round(t_video, 3),
            'raw_value': raw_value,
            'filtered_value': filtered_value
        })

    cap.release()
    return pd.DataFrame(results)

def main():
    video_path = "8.8_164149.MOV"
    date_str = "2026-08-01"
    error_output_dir = "error_frames"

    # 1. 自动解析结束时间并计算开始时间
    try:
        hh, mm, ss = parse_end_time_from_filename(video_path)
    except Exception as e:
        print(f"错误: {e}")
        return

    T_end = build_datetime(date_str, hh, mm, ss)
    duration, fps = get_video_info(video_path)
    T_start_auto = T_end - timedelta(seconds=duration)

    print(f"视频时长: {duration:.2f}s, FPS={fps:.2f}")
    print(f"自动解析的视频结束时间: {T_end}")
    print(f"自动计算的视频开始时间: {T_start_auto}")

    # 2. 用户选择采样起始时间
    print("\n你想用哪个采样起始时间？")
    print("1 = 使用自动计算的视频开始时间")
    print("2 = 手动输入绝对时间，例如 2026-06-20 10:40:00")
    choice = input("请选择 1 或 2: ").strip()

    if choice == "1":
        T_start = T_start_auto
    else:
        user_time = input("请输入采样起始绝对时间 (格式: YYYY-MM-DD HH:MM:SS): ").strip()
        try:
            T_start = datetime.strptime(user_time, "%Y-%m-%d %H:%M:%S")
        except Exception:
            print("输入格式错误，将使用自动计算的视频开始时间。")
            T_start = T_start_auto

    print(f"\n最终采样起始绝对时间: {T_start}")

    # 3. 采样间隔
    try:
        t_input = input("\n请输入采样间隔 (秒)，例如 0.2: ").strip()
        t_seconds = float(t_input) if t_input else 0.2
    except:
        t_seconds = 0.2
    print(f"采样间隔 t = {t_seconds} 秒")

    # 4. 执行正式采样
    df = sample_video_and_ocr(
        video_path,
        T_start,
        duration,
        t_seconds,
        roi_ratio=(0.4, 0.1),   # 使用你调好的 ROI 范围
        error_dir=error_output_dir
    )

    # 5. 保存结果 CSV（Excel 直接打开）
    out_csv = os.path.splitext(video_path)[0] + "_hr_data_full.csv"
    df.to_csv(out_csv, index=False, encoding='utf-8-sig')

    print(f"\n[完成] CSV 结果已保存到: {out_csv}")
    print(f"[提示] 所有识别异常的帧已保存到文件夹: {error_output_dir}")
    print(df.head())

if __name__ == "__main__":
    main()
