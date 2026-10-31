FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py .
RUN useradd --uid 10001 --create-home probe
USER probe
ENV HOST=0.0.0.0 PORT=8790
EXPOSE 8790
CMD ["python", "server.py"]
