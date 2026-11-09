# Bounded research runs

This stage defaults off. Enable `JARVIS_ENABLE_RESEARCH=1` as well as
`JARVIS_ENABLE_KNOWLEDGE=1`, or use their separate native Settings toggles.

`ResearchService` orchestrates existing project-scoped `KnowledgeService`
retrieval, one Gateway synthesis call, a separate Gateway critique call, exact
quote checks and deliverable publication. It does not execute code, certify
factual truth, or create a second worker execution authority.

The default admission estimate is USD 5, the wall-time deadline is 30 minutes,
and collection uses at most two concurrent retrieval operations. Model prompts
and outputs have separate conservative token reservations. Shared Gateway
pricing validates the returned model and reserves tier/cache/region upper
rates. Missing usage or an uncertain provider response prevents another call.
These controls are estimates, not provider-enforced billing caps.

Local evidence is searched inside the exact project. Private source versions
require a current cloud-disclosure grant. A grant is held across model calls;
revocation aborts in-flight reads, and publication and result access recheck
all input source grants. Private goals are never automatically converted into
public search queries. `publicQuery` explicitly opts into the selected public
metadata searches. arXiv/Crossref results remain labeled metadata or abstracts;
they cannot be represented as full-text evidence. Tavily requires an explicit
operator cost allowance because provider billing cannot be inferred here.

Runs persist under `research/research.sqlite`. Interrupted runs are fenced on
restart without replay. Reusing a request ID returns its original run; changing
the input under that ID is rejected. Stop all must call `cancelAll()`. Shutdown
must await `close()` before closing KnowledgeService.

Routes under `/v1/research/runs` accept the authenticated native client or a
root agent with a server-derived project identity. The server must retain the
existing loopback/bearer/Origin checks and stop admission fence. `result`
returns the saved deliverable and the separate critique; the UI should show
both. A model critique may demote a claim and cannot promote it to a verified
fact. Computation checks remain empty because this pipeline did not execute
any calculation or test.
