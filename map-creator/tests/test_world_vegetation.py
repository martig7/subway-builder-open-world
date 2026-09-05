import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_world_vegetation import palette_lookup, vegetation_mask


class WorldVegetationTest(unittest.TestCase):
    def test_uses_source_classes_not_green_or_legend_ids(self):
        xml = '''<ColorMaps><ColorMap><Entries>
        <ColorMapEntry rgb="33,138,33" sourceValue="1" ref="0"/>
        <ColorMapEntry rgb="71,131,181" sourceValue="11" ref="10"/>
        <ColorMapEntry rgb="134,202,227" sourceValue="0,17" ref="16"/>
        <ColorMapEntry rgb="255,0,0" sourceValue="13" ref="12"/>
        <ColorMapEntry rgb="0,0,0" transparent="true"/>
        </Entries></ColorMap></ColorMaps>'''
        palette = palette_lookup(xml, range(1, 12))
        rgba = np.array([[[33,138,33,255], [71,131,181,255], [134,202,227,255],
                          [255,0,0,255], [33,138,33,0]]], dtype=np.uint8)
        self.assertEqual(vegetation_mask(rgba, palette).tolist(), [[1,1,0,0,0]])

    def test_interpolated_unknown_colors_are_not_guessed(self):
        with self.assertRaisesRegex(ValueError, 'do not match'):
            vegetation_mask(np.array([[[1,2,3,255]]], dtype=np.uint8), {(33,138,33): True})


if __name__ == '__main__':
    unittest.main()
