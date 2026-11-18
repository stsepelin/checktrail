import argparse,json,os,pathlib,sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from meter import sample
from common import encoded,replace_json
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);a=p.parse_args();result=sample('/work');target=pathlib.Path('/evidence/LIVE-METER.json');os.chown(target.parent,0,0)
 try:replace_json(target,result);os.chown(target,a.uid,a.gid)
 finally:os.chown(target.parent,a.uid,a.gid)
 print(json.dumps(result));raise SystemExit(0 if result['samplingComplete'] else 2)
