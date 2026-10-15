FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py render.py ./
COPY probe/ probe/
RUN useradd --uid 10001 --no-create-home probe
USER 10001
ENV PYTHONUNBUFFERED=1 PROBE_CONFIG=/etc/heartbeat-probe/config.yaml
EXPOSE 8080
CMD ["python", "app.py"]
