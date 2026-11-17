"""Bounded Node builtin-crypto adapter; no action on import."""
import pathlib,re,time
from common import need,encoded,freeze,read_json,digest,process,hash_file
HERE=pathlib.Path(__file__).resolve().parent
def operation(folder,mode,request,deadline):
 need(mode in ['validate-recipient','encrypt','decrypt','sign-ack','verify-ack'],'exact builtin crypto mode');folder=pathlib.Path(folder);need(not folder.exists(),'fresh owned crypto operation evidence');folder.mkdir(mode=0o700);file=folder/'REQUEST.json';freeze(file,encoded(request));row,p=process(['node',str(HERE/'envelope.mjs'),mode,str(file)],folder/'NODE',deadline,131072);need(row['exitCode']==0 and row['reason'] is None,'authenticated private crypto operation incomplete');value=read_json(p,131072);need(time.monotonic()<deadline,'crypto response capture/parse exhausted original budget');return value
def ack_payload(series,roundtrip_receipt,ledger):
 envelope=series['archive'];plain=envelope['plaintext'];return {'schemaVersion':1,'kind':'checktrail-sdk10-durable-recovery-ack-v1','context':series['context'],'seriesSHA256':digest(encoded(series)),'ciphertext':{k:envelope[k] for k in ['bytes','sha256','headerSHA256']},'plaintext':{k:plain[k] for k in ['bytes','sha256','internalMemberMapSHA256']},'payloadParts':series['plan']['payloadParts'],'totalCarriers':series['plan']['totalCarriers'],'durableRoundtripReceiptSHA256':roundtrip_receipt,'custodyLedgerSHA256':ledger}
def validate_ack_payload(value,series):
 need(type(value) is dict,'signed recovery payload dictionary')
 for k in ['durableRoundtripReceiptSHA256','custodyLedgerSHA256']:need(re.fullmatch('[0-9a-f]{64}',value.get(k,'')),'signed durable local receipt hash')
 expected=ack_payload(series,value['durableRoundtripReceiptSHA256'],value['custodyLedgerSHA256']);need(value==expected,'exact signed context/cipher/plain/member-map/count recovery acknowledgement');return expected
