import json
import os
import sys
from pathlib import Path
import urllib.request
import urllib.error

# Automatically load environment variables from .env file if present
def load_dotenv():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.is_file():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'\"")
                if k and k not in os.environ:
                    os.environ[k] = v

load_dotenv()

API_KEY = os.getenv("DASHSCOPE_API_KEY")
BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL",
    "https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1",
)
MODEL = os.getenv("PLANNER_MODEL", "qwen3.8-flash")


def call_planner_openai(prompt: str, model: str = MODEL, enable_thinking: bool = True):
    """Call DashScope Responses API using the OpenAI Python SDK."""
    from openai import OpenAI

    client = OpenAI(
        api_key=API_KEY,
        base_url=BASE_URL,
    )
    response = client.responses.create(
        model=model,
        input=prompt,
        extra_body={"enable_thinking": enable_thinking},
    )
    return response


def call_planner_urllib(prompt: str, model: str = MODEL, enable_thinking: bool = True):
    """Fallback zero-dependency caller using standard library urllib."""
    url = BASE_URL.rstrip("/") + "/responses"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "input": prompt,
        "enable_thinking": enable_thinking,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_planner(prompt: str):
    if not API_KEY:
        print("Error: DASHSCOPE_API_KEY environment variable is not set.", file=sys.stderr)
        print("Please check your .env file in the project root.", file=sys.stderr)
        sys.exit(1)

    print(f"Calling planner model ({MODEL})...\nPrompt: {prompt}\n")

    try:
        # Try OpenAI SDK first
        import openai  # noqa: F401
        response = call_planner_openai(prompt)
        for item in response.output:
            if getattr(item, "type", None) == "reasoning":
                print("【推理过程】")
                for summary in getattr(item, "summary", []):
                    text = getattr(summary, "text", "")
                    print(text[:500])
                print()
            elif getattr(item, "type", None) == "message":
                print("【最终答案】")
                for content in getattr(item, "content", []):
                    print(getattr(content, "text", ""))
    except ImportError:
        # Fallback to pure urllib when openai package is not installed
        result = call_planner_urllib(prompt)
        output = result.get("output", [])
        for item in output:
            item_type = item.get("type")
            if item_type == "reasoning":
                print("【推理过程】")
                for summary in item.get("summary", []):
                    text = summary.get("text", "")
                    print(text[:500])
                print()
            elif item_type == "message":
                print("【最终答案】")
                for content in item.get("content", []):
                    print(content.get("text", ""))


if __name__ == "__main__":
    prompt = sys.argv[1] if len(sys.argv) > 1 else "9.9和9.11哪个大？"
    run_planner(prompt)
