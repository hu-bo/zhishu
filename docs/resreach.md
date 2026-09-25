你是一个资深全栈架构师，请根据以下项目定义，输出一份完整的技术设计文档(4个文档：server系统层，server RAG + AI创作， 前端系统平台，前端协同组件)。
【项目定义】
AI驱动的企业智能文档平台。
技术栈：React + Tiptap（ProseMirror内核，Headless架构） + Yjs（CRDT协作）。
数据格式：Tiptap JSON，Block级结构化输出。
部署形态：企业私有化部署，支持多空间隔离。
【核心能力模块】
AI文档创建：LLM输出映射为Tiptap自定义Node/Block，通过editor.commands插入编辑器。
布局更新：Block级增删改，支持动态重排，AI可局部更新指定Block而非全文覆盖。
向量化：基于Tiptap JSON按Block粒度分块Embedding，存入向量数据库，文档变更时增量更新索引。
RAG检索：用户自然语言提问 → Query Embedding → 向量相似度召回Top-K → Rerank → Context拼装 → LLM生成带引用来源的回答，按空间namespace隔离。
AI创作：基于RAG召回的企业知识上下文，LLM生成/续写/改写/摘要/翻译，输出流式写入编辑器（SSE），支持局部Block级精准更新。
企业文档平台：权限管理、版本控制、审批流、审计日志。
空间=知识库：每个空间独立知识域，向量检索按空间隔离，确保知识边界。
【关键技术要点】
Tiptap扩展体系定义自定义NodeType（ai-block、embed-block、rag-citation等）
Yjs Awareness实现协作光标和在线状态
Yjs Doc同步通过WebSocket传输
RAG Pipeline完整链路
AI创作流式输出通过editor.commands.insertContentAt()按位置插入
空间维度namespace隔离检索和创作的知识边界
【输出要求】
请输出一份完整的技术设计文档，包含以下章节：
一、项目概述
背景与目标
核心能力总览（表格形式）
技术栈选型及理由
二、系统架构
整体架构图（用文字描述，分层：前端层/协作层/服务层/AI层/数据层）
各层职责与交互关系
数据流全景（从用户输入到AI生成到渲染到向量化）
三、编辑器层设计（React + Tiptap）
组件架构
自定义Node/Block定义（含Schema示例）
扩展体系设计
布局更新机制（Block级操作）
与AI模块的对接接口
能够开放能力给其他业务使用
四、协作层设计（Yjs）
CRDT数据模型
WebSocket同步方案
Awareness（光标/在线状态）
冲突解决策略
版本控制与历史回溯
五、AI服务层设计
AI文档创建：Prompt工程、输出Schema、Block映射策略
AI创作：流式输出（SSE）、局部Block更新、上下文窗口管理
Prompt模板示例
六、RAG检索层设计
向量化策略：Block粒度分块、Embedding模型选型
向量数据库选型与Schema
检索Pipeline：Query → Embedding → Top-K → Rerank → Context拼装
空间隔离与namespace设计
增量索引更新机制
七、企业能力层设计
空间与知识库模型
权限体系(不同企业权限不同，通过插件的形式开放)
八、数据模型
核心表结构（文档、空间、Block、版本、权限、向量索引）
ER关系描述
九、API设计
核心RESTful接口列表（含路径、方法、入参、出参）
WebSocket接口
SSE流式接口
十、前端工程结构
React项目目录结构
核心模块划分
状态管理方案