FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt fetch_model.py ./
RUN pip install --no-cache-dir -r requirements.txt && python3 fetch_model.py
COPY server.py ./

RUN useradd --system voice
USER voice
ENV PORT=8080 THREADS=2
EXPOSE 8080
CMD ["python3", "server.py"]
