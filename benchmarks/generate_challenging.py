"""A second, more varied synthetic corpus; all codes are fictional."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, random

root=Path(__file__).resolve().parents[1]; target=root/'fixtures/challenging'; target.mkdir(parents=True,exist_ok=True)
groups=[['AAAAA','BBBBB','CCCCC','DDDDD','EEEEE'],['FFFFF','GGGGG','HHHHH','JJJJJ','KKKKK'],['LLLLL','MMMMM','NNNNN','PPPPP','QQQQQ']]
manifest=[]
for index in range(12):
    rng=random.Random(2900+index); width,height=900,200
    image=Image.new('RGB',(width,height),(22,23,25)); draw=ImageDraw.Draw(image)
    frame=(30,20,870,180); draw.rectangle(frame,fill=(55+rng.randrange(50),55+rng.randrange(40),85+rng.randrange(70)))
    for _ in range(80):
        x,y=rng.randrange(31,860),rng.randrange(21,170); size=rng.randrange(3,45)
        color=tuple(rng.randrange(30,190) for _ in range(3)); draw.rectangle((x,y,min(869,x+size),min(179,y+size)),fill=color)
    values=groups[index%3]; shift=index%5; key='-'.join(values[(shift+i)%5] for i in range(5))
    fontname='arialbd.ttf' if index%2==0 else 'consolab.ttf'; size=[14,16,18,22][index%4]
    font=ImageFont.truetype(str(Path('C:/Windows/Fonts')/fontname),size)
    draw.text((60,90),key,font=font,fill='white',stroke_width=1,stroke_fill='black')
    filename=f'case-{index:02d}'+('.jpg' if index%3==0 else '.png'); path=target/filename
    if path.suffix=='.jpg': image.save(path,quality=65)
    else: image.save(path)
    manifest.append({'path':str(path.relative_to(root)).replace('\\','/'),'expected':key})
(target/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(f'{len(manifest)} challenging fixtures written')
