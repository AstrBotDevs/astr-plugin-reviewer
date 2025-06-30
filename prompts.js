export const MAIN_FILE_PROMPT = `
## 核心审查要求

### 1. 版本与运行环境
- **Python 版本**: 严格限定为 Python 3.10 进行审查。
- **运行环境**: 代码运行在异步环境中。

### 2. 综合审查维度
请从以下五个维度进行全面分析：
- **代码质量与编码规范**:
    - 是否遵循 PEP 8 规范？
    - 命名是否清晰、表意明确？
    - 是否有过于复杂的代码块可以简化？
- **功能实现与逻辑正确性**:
    - 代码是否能够正确实现其预期功能？
    - 是否存在明显的逻辑错误或边界条件处理不当？
- **安全漏洞与最佳实践**:
    - 是否存在常见的安全漏洞（如：不安全的外部命令执行、硬编码的敏感信息、不安全的 pickle 反序列化等）？
    - 是否遵循了 Python 社区公认的最佳实践？
- **可维护性与可读性**:
    - 代码结构是否清晰，易于理解和维护？
    - 注释是否恰当且有效？（不多余，也不缺失）
    - 函数和类的职责是否单一明确？
- **潜在缺陷或问题**:
    - 是否存在潜在的性能瓶颈？
    - 是否有未处理的异常或资源泄漏风险？

### 3. 强制性规则检查 (必须严格遵守)

以下是必须严格执行的检查项，如有违反，必须明确指出：

- **日志记录**:
    - 日志记录器 logger **必须且只能**从 astrabot.api 导入 (即 from astrbot.api import logger)。
    - **严禁**使用任何其他第三方日志库（如 loguru）或 Python 内置的 logging 模块（例如 logging.getLogger）。

- **并发模型**:
    - 检查代码中是否存在**同步阻塞**操作（例如，长时间的 CPU 计算、未使用 await 的文件 I/O、未使用 await 的网络请求等操作）。
    - 如果存在同步代码，**必须**检查它是否被正确地放入线程中执行（例如使用 asyncio.to_thread）或换用异步库，以避免阻塞整个异步事件循环。
    - 如果同步文件 I/O 操作可以很快完成，**可以**考虑直接在事件循环中执行，而不必使用线程。
    - 频繁的线程切换会带来开销。如果阻塞操作非常轻量，评估是否真的需要卸载到线程中。

### 4. 针对 main.py 的额外审查要求 (必须严格遵守)

除了上述通用规则，还需对 main.py 的结构进行以下专项检查：

- **插件注册与主类**:
    - 文件中**必须**存在一个继承自 Star 的类。
    - 该类**必须**使用 @register 装饰器进行注册。
    - 注册格式应为 @register("插件名", "作者", "描述", "版本")。
    - **正确示例**:

      @register("helloworld", "Soulter", "一个简单的 Hello World 插件", "1.0.0")
      class MyPlugin(Star):
          def __init__(self, context: Context):
              super().__init__(context)
      

- **filter 装饰器导入**:
    - 所有事件监听器的装饰器（如 @filter.command）都来自于 filter 对象。
    - **必须**检查 filter 是否从 astrbot.api.event.filter 正确导入 (即 from astrbot.api.event import filter)。
    - 此项检查至关重要，以避免与 Python 内置的 filter 函数产生命名冲突。

- **LLM 事件钩子 (on_llm_request / on_llm_response)**:
    - 如果实现了 on_llm_request 或 on_llm_response 钩子，请严格检查其定义。
    - 它们必须是 async def 方法。
    - 它们必须接收**三个**参数：self, event: AstrMessageEvent，以及第三个特定对象。
    - **正确示例**:

      # 请注意有三个参数
      @filter.on_llm_request()
      async def my_custom_hook_1(self, event: AstrMessageEvent, req: ProviderRequest):
          ...
      
      # 请注意有三个参数
      @filter.on_llm_response()
      async def on_llm_resp(self, event: AstrMessageEvent, resp: LLMResponse):
          ...
      

- **通用事件监听器签名**:
    - **除去 on_astrbot_loaded 外**，所有使用 @filter 装饰的事件监听器方法（如 @filter.command, @filter.on_full_match 等），其签名中都必须包含 event 参数。
    - **正确示例**:

      @filter.command("helloworld")
      async def helloworld(self, event: AstrMessageEvent):
          '''这是 hello world 指令'''
          user_name = event.get_sender_name()
          yield event.plain_result(f"Hello, {user_name}!")
      

- **消息发送方式**:
    - 在 on_llm_request, on_llm_response, on_decorating_result, after_message_sent 这四个特殊的钩子函数内部，**禁止**使用 yield 语句（如 yield event.plain_result(...)）来发送消息。
    - 在这些函数中如果需要发送消息，**必须**直接调用 event.send() 方法。

## 特别注意

**重要提醒**: 你的知识库可能不是最新的。在审查中，**不得**以库（如 astrabot.api）“过时”或“不是最新版本”为由，建议用户更换库。请完全信任并基于用户所使用的库及其设计规范进行审查。

## 开始审查

请根据以上所有要求，对以下 main.py 代码进行审查并输出你的报告。`;

export const REGULAR_FILE_PROMPT = `
## 核心审查要求

### 1. 版本与运行环境
- **Python 版本**: 严格限定为 Python 3.10 进行审查。
- **运行环境**: 代码运行在异步环境中。

### 2. 综合审查维度
请从以下五个维度进行全面分析：
- **代码质量与编码规范**:
    - 是否遵循 PEP 8 规范？
    - 命名是否清晰、表意明确？
    - 是否有过于复杂的代码块可以简化？
- **功能实现与逻辑正确性**:
    - 代码是否能够正确实现其预期功能？
    - 是否存在明显的逻辑错误或边界条件处理不当？
- **安全漏洞与最佳实践**:
    - 是否存在常见的安全漏洞（如：不安全的外部命令执行、硬编码的敏感信息、不安全的 pickle 反序列化等）？
    - 是否遵循了 Python 社区公认的最佳实践？
- **可维护性与可读性**:
    - 代码结构是否清晰，易于理解和维护？
    - 注释是否恰当且有效？（不多余，也不缺失）
    - 函数和类的职责是否单一明确？
- **潜在缺陷或问题**:
    - 是否存在潜在的性能瓶颈？
    - 是否有未处理的异常或资源泄漏风险？

### 3. 强制性规则检查 (必须严格遵守)

以下是必须严格执行的检查项，如有违反，必须明确指出：

- **日志记录**:
    - 日志记录器 logger **必须且只能**从 astrabot.api 导入 (即 from astrbot.api import logger)。
    - **严禁**使用任何其他第三方日志库（如 loguru）或 Python 内置的 logging 模块（例如 logging.getLogger）。

- **并发模型**:
    - 检查代码中是否存在**同步阻塞**操作（例如，长时间的 CPU 计算、未使用 await 的文件 I/O、未使用 await 的网络请求等操作）。
    - 如果存在同步代码，**必须**检查它是否被正确地放入线程中执行（例如使用 asyncio.to_thread）或换用异步库，以避免阻塞整个异步事件循环。
    - 如果同步文件 I/O 操作可以很快完成，**可以**考虑直接在事件循环中执行，而不必使用线程。
    - 频繁的线程切换会带来开销。如果阻塞操作非常轻量，评估是否真的需要卸载到线程中。

## 特别注意

**重要提醒**: 你的知识库可能不是最新的。在审查中，**不得**以库“过时”或“不是最新版本”为由，建议用户更换库。请完全信任并基于用户所使用的库及其设计规范进行审查。

## 开始审查

请根据以上所有要求，对以下代码进行审查并输出你的报告。`;
