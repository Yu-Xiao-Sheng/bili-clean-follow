# 贡献指南（Contribution Guide）

Thanks for your interest in contributing to bili-clean-follow !

## 如何贡献（How to Contribute）

1. **Report a bug** — open an Issue with enough context (steps to reproduce, environment, expected vs actual).
2. **Request a feature** — open a Discussion so the community can weigh in before we build.
3. **Send a PR** — fork the repo, branch, code, test, push, open a PR.

## 开发环境（Dev Environment）

本项目 **纯本地、零第三方依赖**（local, zero third-party deps）。只需 Python 3.9+。

```
python -m venv .venv
.venv\Scripts\activate        # Windows
source .venv/bin/activate     # macOS/Linux
pip install -e .              # 安装本包（自身无依赖）
pip install pytest            # 仅跑测试需要
```

运行全部测试：

```
python -m pytest tests -q
```

全部通过后再开 PR。

## 项目约定（Project Conventions）

- **报告-only**：工具不得执行 unfollow 等写操作。
- **零第三方依赖**：新特性不得引入 pip 包。
- **透明**：新特性必须可解释（分数或可读原因）。
- **中文优先**：代码注释与文档默认中文。

## PR 规范（PR Guidelines）

1. PR 小而专注。
2. 运行 `python -m pytest tests -q` 并确保全过。
3. 用户可见变更更新 CHANGELOG.md。
4. 遵循 PEP 8 并加类型注解。

## 代码风格（Code Style）

- PEP 8
- 类型注解
- 中文注释