# GPQA diamond (MC fixed-letter variant) local adapter for evalscope.
# Registered as 'gpqa_mc'; dataset is a local JSONL so both runs see the
# exact same prompts (paired methodology, temp 0).
import json
import os
from typing import Any, Dict, List

from evalscope.api.benchmark import BenchmarkMeta, MultiChoiceAdapter
from evalscope.api.dataset import Sample
from evalscope.api.registry import register_benchmark
from evalscope.constants import Tags
from evalscope.utils.logger import get_logger
from evalscope.utils.multi_choices import MultipleChoiceTemplate

logger = get_logger()

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gpqa_data', 'gpqa_diamond_mc.jsonl')


@register_benchmark(
    BenchmarkMeta(
        name='gpqa_mc',
        pretty_name='GPQA-Diamond-MC',
        tags=[Tags.KNOWLEDGE, Tags.MULTIPLE_CHOICE, Tags.CUSTOM],
        description='GPQA Diamond (198 questions, fixed A-D choice order) from a local JSONL, '
                    'paired-comparison friendly.',
        dataset_id=DATA_FILE,
        subset_list=['biology', 'physics', 'chemistry'],
        metric_list=['acc'],
        few_shot_num=0,
        train_split='train',
        eval_split='train',
        prompt_template=MultipleChoiceTemplate.SINGLE_ANSWER_COT,
    )
)
class GPQAMCAdapter(MultiChoiceAdapter):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.reformat_subset = True

    def load_from_disk(self, **kwargs):
        return super().load_from_disk(use_local_loader=True)

    def record_to_sample(self, record: Dict[str, Any]) -> Sample:
        return Sample(
            input=record['question'],
            choices=[record['A'], record['B'], record['C'], record['D']],
            target=record['answer'],
            subset_key=record['domain'].lower(),
            metadata={
                'domain': record['domain'].lower(),
                'question_id': record['id'],
            },
        )


def gold_map() -> Dict[int, str]:
    rows: List[Dict[str, Any]] = [json.loads(l) for l in open(DATA_FILE) if l.strip()]
    return {r['id']: r['answer'] for r in rows}
