> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Available Models

> Explore NEAR AI Cloud model catalog

NEAR AI Cloud provides access to leading AI models, each optimized for different use cases ranging from advanced reasoning and tool calling to long-context processing, embeddings, reranking, image generation, and audio transcription — all with transparent, pay-per-use pricing.

The [model catalog](https://near.ai/models) labels every model with one of three privacy tiers:

* **Confidential TEE** (marked Confidential TEE) models run on NEAR AI's own GPU fleet inside [Trusted Execution Environments](https://docs.near.ai/cloud/private-inference.md). They support [attestation, signatures, and verification](https://docs.near.ai/cloud/verification), and nobody, not even NEAR, can see your prompts or outputs.
* **3P Confidential TEE** models run inside a third-party provider's Trusted Execution Environment. Their provider is listed as **Attested 3P**. The request path to the provider's enclave is encrypted, and the provider publishes its own [attestation evidence](https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md). Model-level verification depends on the client: the JavaScript SDK verifies Chutes model attestation, while the Python SDK verifies the Gateway only.
* **Incognito** models (OpenAI, Anthropic, Gemini, and others) are routed through the NEAR AI Gateway, which runs in a TEE, and sent to the provider under NEAR AI's provider account. Your NEAR AI credentials are not forwarded to the provider. The model itself runs on the provider's infrastructure, outside a TEE, so the TEE privacy and verifiability guarantees do not extend to the upstream provider.

[Browse Model Catalog →](https://near.ai/models)

> [!TIP]
>
> **Model metadata**
>
> The [`/v1/models`](https://cloud-api.near.ai/v1/models) endpoint reports each model's context length, max output length, pricing (including discounted cache-read pricing — see [Prompt Caching](https://docs.near.ai/cloud/guides/prompt-caching.md)), supported features (`tools`, `structured_outputs`, `reasoning`), supported sampling parameters, and input/output modalities.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.