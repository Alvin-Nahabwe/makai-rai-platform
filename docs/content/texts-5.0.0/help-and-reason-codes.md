# The document help lines and reason codes of content 5.0.0

## Document help lines

| Document | Help line |
|---|---|
| data_card | Teams use this as the description of the data in a data transfer agreement, or as dataset documentation for a conference or repository. Check what your requester asks for. |
| model_card | Teams paste this into a model card on a repository such as Hugging Face, or use it to answer a venue's checklist. It informs, but does not replace, a regulator's technical file. |
| mitigation_plan | Teams use this where a protocol, a data protection impact assessment or a funder asks for the risks and the measures against them. A plan from a later seal can go with an annual renewal or an amendment. The platform does not estimate likelihood or impact: if your template asks for them, add them outside the platform. |

## Reason codes

| Code | Status | Label | Use it when | The reason must say |
|---|---|---|---|---|
| `na_no_personal_data` | not_applicable | No personal data is involved | The project holds no information that could identify a person. Set by the platform on Q-PP-13 and Q-PP-14 when the gate is "no". | How you know: which data you checked. |
| `na_no_people_affected` | not_applicable | The system makes no decisions or predictions about people | Its outputs are about things (crops, roads, weather) and no person is judged by them. | Who uses the outputs, and why no person is affected. Use carefully: a crop model's errors still fall on farmers. |
| `na_no_deployment` | not_applicable | The system will not be used beyond the research study | Post-processing practices for a model that will never be deployed. | What would change this, for example a plan to hand the model to a ministry. |
| `na_not_this_kind_of_system` | not_applicable | Does not apply to this kind of system or method | For example, no labels exist, so label quality does not apply; or the system is rule-based. | What kind of system it is. |
| `na_answered_elsewhere` | not_applicable | Answered under another question | Another question already records the same practice. | The other question's id. |
| `na_other` | not_applicable | Other | None of the above. | Why the practice does not apply. |
| `ny_planned_later` | not_yet | Planned for a later point in the project | The practice belongs to a later step, for example monitoring before deployment. | When it is planned. |
| `ny_awaiting_ethics` | not_yet | Waiting for an ethics or regulatory decision | A committee or regulator must decide first. | Which body, and when you applied. |
| `ny_awaiting_data_access` | not_yet | Waiting for data or data-access approval | The data, or permission to use it, has not arrived. | From whom. |
| `ny_awaiting_partner` | not_yet | Waiting for a partner or another team | Someone outside the team must act first. | Who, by role. |
| `ny_needs_resources` | not_yet | Needs money, computing or staff time the project does not have | The team knows how but cannot pay for it or staff it now. | What is missing. |
| `ny_needs_skills` | not_yet | Needs skills or guidance the team does not have yet | The team does not yet know how. The suggestions, templates and notebooks are aimed at this case. | What the team needs to learn. |
| `ny_first_considered` | not_yet | Not considered before this record | The question raised something the team had not thought about. | Nothing more; this is an honest answer. |
| `ny_other` | not_yet | Other | None of the above. | Why the practice is not yet in place. |

Batch `help-and-reason-codes` sha256: `41202f286c150863e9a8986593af7fbf77210d29ebc3ca607bba23c140dfbe0a`
