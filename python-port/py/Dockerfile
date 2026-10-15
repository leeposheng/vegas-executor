FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY vegas_executor ./vegas_executor
# 狀態檔（去重、暫停、事件日誌）放在 /data；請在 Zeabur 掛載 Volume 到 /data
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["python", "-m", "vegas_executor"]
